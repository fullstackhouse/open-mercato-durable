// Real child processes, killed for real.
//
// Everything else in the harness simulates a dead worker by expiring its lease. That proves
// the statements are right, but not that the mechanism survives what actually happens: a
// process removed from the world between two writes, with no chance to release anything, no
// finally block, no shutdown hook. SIGKILL is the only way to test that honestly.

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export type ReplicaOptions = {
  postgresUrl: string
  jobId: string
  tenantId: string
  organizationId: string | null
  batches: number
  /** Milliseconds per batch, so the parent can kill the child at a predictable point. */
  batchMs: number
  seq?: number
  redrives?: number
  label?: string
}

export type Replica = {
  process: ChildProcess
  /** Resolves with each batch index as the child commits it. */
  onCommitted: (predicate: (index: number) => boolean) => Promise<number>
  kill(signal?: NodeJS.Signals): void
  exited: Promise<number | null>
  output: string[]
}

/** Starts a child that claims the job and runs one slice. */
export function startReplica(options: ReplicaOptions): Replica {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(HERE, 'worker-entry.ts')],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        REPLICA_PG_URL: options.postgresUrl,
        REPLICA_JOB_ID: options.jobId,
        REPLICA_TENANT_ID: options.tenantId,
        REPLICA_ORG_ID: options.organizationId ?? '',
        REPLICA_BATCHES: String(options.batches),
        REPLICA_BATCH_MS: String(options.batchMs),
        REPLICA_SEQ: String(options.seq ?? 0),
        REPLICA_REDRIVES: String(options.redrives ?? 0),
        REPLICA_LABEL: options.label ?? 'replica',
      },
    },
  )

  const output: string[] = []
  const committed: number[] = []
  const waiters: Array<{ predicate: (index: number) => boolean; resolve: (index: number) => void }> = []

  const consume = (line: string) => {
    output.push(line)
    const match = /^committed (\d+)$/.exec(line.trim())
    if (!match) return
    const index = Number(match[1])
    committed.push(index)
    for (const waiter of [...waiters]) {
      if (waiter.predicate(index)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(index)
      }
    }
  }

  let buffer = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consume(line)
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => output.push(`stderr: ${chunk}`))

  return {
    process: child,
    output,
    onCommitted: (predicate) =>
      new Promise<number>((resolve, reject) => {
        const already = committed.find(predicate)
        if (already !== undefined) return resolve(already)
        waiters.push({ predicate, resolve })
        const timer = setTimeout(() => reject(new Error(`replica never committed a matching batch; saw: ${output.join(' | ')}`)), 30_000)
        timer.unref?.()
      }),
    kill: (signal: NodeJS.Signals = 'SIGKILL') => child.kill(signal),
    exited: once(child, 'exit').then(([code]) => (typeof code === 'number' ? code : null)),
  }
}
