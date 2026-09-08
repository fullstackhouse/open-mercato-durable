// Three worker replicas, killed at random, for as long as you ask.
//
// This is the evidence the design rests on. Every scenario in the test suites is a failure
// somebody arranged; the soak is the one that produces them the way production does — several
// processes competing for the same jobs, one of them dying without warning at a moment nobody
// chose, over and over.
//
//   yarn workspace @fullstackhouse/durable-harness soak --replicas 3 --minutes 10 --transport pgboss
//
// Four invariants are checked at the end. Each is stated as the failure it rules out, because
// that is what makes an invariant worth checking rather than worth writing down:
//
//   1. every job ends terminal          — nothing is left running forever, which is the whole point
//   2. owners never interleave          — the lease is real, not advisory
//   3. no batch is ever skipped         — work is not lost, which is the guarantee being sold
//   4. no expired lease left running    — the reconciler kept up with the killing
//
// Two invariants this file used to assert were simply wrong, and the first run said so:
//
//   "one owner per slice" — a re-drive bumps `redrives`, not `continuation_seq`, so a new owner
//   legitimately claims the same seq after a worker dies. Sequential owners are the mechanism
//   working. What must not happen is two owners writing at *overlapping* times.
//
//   "no batch runs twice" — delivery is at-least-once by construction. A process killed between
//   a batch's write and its checkpoint commit will redo that batch, and that is the documented
//   cost, stated in the adapter contract. Repetition is allowed; loss is not.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { store, type Scope } from '@fullstackhouse/open-mercato-durable-work'

import { connect, migrate, type PgExecutor } from '../db'
import { SOAK_BATCHES, SOAK_KIND, SOAK_QUEUE } from './shared'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback
}

const replicas = Number(arg('replicas', '3'))
const minutes = Number(arg('minutes', '10'))
const transport = arg('transport', process.env.DURABLE_TRANSPORT ?? 'pgboss')
const postgresUrl = process.env.HARNESS_PG_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
const bossSchema = `soak_${randomUUID().replace(/-/g, '').slice(0, 10)}`

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }))

async function main(): Promise<void> {
  const sql = await connect(postgresUrl, { max: 10 })
  await migrate(sql)
  await sql.query(`create table if not exists soak_audit (
    id uuid primary key, job_id uuid not null, seq int not null, batch int not null, owner text not null, at timestamptz not null
  )`)
  await sql.query('truncate soak_audit')

  const scope: Scope = { tenantId: randomUUID(), organizationId: randomUUID() }
  log('soak.start', { replicas, minutes, transport, tenantId: scope.tenantId })

  const start = (index: number): ChildProcess => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(HERE, 'worker-replica.ts')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SOAK_PG_URL: postgresUrl,
        SOAK_TRANSPORT: transport,
        SOAK_BOSS_SCHEMA: bossSchema,
        SOAK_CONCURRENCY: '3',
      },
    })
    child.stdout!.on('data', (chunk: Buffer) => process.stdout.write(`[r${index}] ${chunk}`))
    child.stderr!.on('data', (chunk: Buffer) => process.stderr.write(`[r${index}!] ${chunk}`))
    return child
  }

  let running: ChildProcess[] = Array.from({ length: replicas }, (_unused, index) => start(index))

  // Jobs keep arriving throughout, so the fleet is never idle and a kill always lands on work
  // in flight rather than on a quiet system.
  const created: string[] = []
  const producer = setInterval(() => {
    void (async () => {
      const id = randomUUID()
      await store.insertJob(sql, id, scope, { kind: SOAK_KIND, totalCount: SOAK_BATCHES }, SOAK_QUEUE).catch(() => undefined)
      created.push(id)
    })()
  }, 400)

  // The killing. No grace, no signal handler on the other end: the process is simply gone
  // between two of its own writes.
  const killer = setInterval(() => {
    const index = Math.floor(Math.random() * running.length)
    const victim = running[index]!
    log('soak.kill', { replica: index, pid: victim.pid })
    victim.kill('SIGKILL')
    running[index] = start(index)
  }, 4_000)

  await new Promise((resolve) => setTimeout(resolve, minutes * 60_000))

  clearInterval(producer)
  clearInterval(killer)
  log('soak.draining', { created: created.length })

  // Long enough for the reconciler to repair whatever the last kill left behind.
  await new Promise((resolve) => setTimeout(resolve, 45_000))
  for (const child of running) child.kill('SIGKILL')
  running = []

  const failures = await check(sql, scope)
  log('soak.finished', { created: created.length, failures: failures.length })
  for (const failure of failures) log('soak.violation', failure)

  await sql.end()
  process.exit(failures.length ? 1 : 0)
}

async function check(sql: PgExecutor, scope: Scope): Promise<Array<Record<string, unknown>>> {
  const failures: Array<Record<string, unknown>> = []

  // 1. Nothing left running or pending: the reconciler repaired every job the killing broke.
  const unfinished = await sql.query<{ id: string; status: string; n: number }>(
    `select status, count(*)::int as n from durable_work_jobs where tenant_id = $1 group by status`,
    [scope.tenantId],
  )
  const byStatus = Object.fromEntries(unfinished.rows.map((row) => [row.status, row.n]))
  log('soak.final_states', byStatus)
  for (const status of ['pending', 'running']) {
    if (byStatus[status]) failures.push({ invariant: 'every job ends terminal', status, count: byStatus[status] })
  }

  // 2. Owners never interleave.
  //
  //    Each owner's writes for a job form an interval. A clean handover — one worker dies, the
  //    reconciler re-drives, another picks it up — gives disjoint intervals. Overlapping ones
  //    mean two processes were writing for the same job at the same time, which is precisely
  //    what the lease and its epoch exist to prevent. Recorded inside `fencedWrite`, so if the
  //    fence were advisory rather than real, both owners' rows would be here to show it.
  const interleaved = await sql.query<{ job_id: string; a: string; b: string }>(
    `with spans as (
       select job_id, owner, min(at) as started, max(at) as ended
         from soak_audit group by job_id, owner
     )
     select x.job_id, x.owner as a, y.owner as b
       from spans x join spans y on x.job_id = y.job_id and x.owner < y.owner
      where x.started <= y.ended and y.started <= x.ended
      limit 20`,
  )
  for (const row of interleaved.rows) {
    failures.push({ invariant: 'owners never interleave', jobId: row.job_id, owners: [row.a, row.b] })
  }

  // 3. No batch is ever skipped.
  //
  //    This is the guarantee being sold. A batch may be *repeated* — a process killed between
  //    its write and its checkpoint commit will redo it, which is what at-least-once means and
  //    what the adapter contract asks adapters to tolerate. A batch that never ran at all is
  //    work silently lost, and no amount of killing may produce one.
  const incomplete = await sql.query<{ job_id: string; batches: number }>(
    `select j.id as job_id, count(distinct a.batch)::int as batches
       from durable_work_jobs j left join soak_audit a on a.job_id = j.id
      where j.tenant_id = $1 and j.status = 'completed'
      group by j.id having count(distinct a.batch) <> $2 limit 20`,
    [scope.tenantId, SOAK_BATCHES],
  )
  for (const row of incomplete.rows) {
    failures.push({ invariant: 'no batch is ever skipped', jobId: row.job_id, distinctBatches: row.batches, expected: SOAK_BATCHES })
  }

  // 4. Nothing running on a lease that expired long ago — the reconciler kept pace.
  const stale = await sql.query<{ n: number }>(
    `select count(*)::int as n from durable_work_jobs
      where tenant_id = $1 and status = 'running' and lease_expires_at < now() - interval '60 seconds'`,
    [scope.tenantId],
  )
  if (stale.rows[0]!.n > 0) failures.push({ invariant: 'no abandoned lease outlives the reconciler', count: stale.rows[0]!.n })

  const completed = await sql.query<{ n: number }>(
    `select count(*)::int as n from durable_work_jobs where tenant_id = $1 and status = 'completed'`,
    [scope.tenantId],
  )
  const audited = await sql.query<{ n: number }>(`select count(*)::int as n from soak_audit`)
  // Repeats are reported, not failed: they are the visible cost of at-least-once delivery, and
  // a soak that never produced one would mean the killing was not landing mid-slice.
  const repeats = await sql.query<{ n: number }>(
    `select coalesce(sum(times - 1), 0)::int as n from (
       select count(*) as times from soak_audit group by job_id, batch having count(*) > 1
     ) repeated`,
  )
  log('soak.summary', {
    completed: completed.rows[0]!.n,
    fencedWrites: audited.rows[0]!.n,
    repeatedBatches: repeats.rows[0]!.n,
  })

  return failures
}

await main()
