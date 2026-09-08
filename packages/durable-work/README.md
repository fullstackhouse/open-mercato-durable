# @fullstackhouse/open-mercato-durable-work

Durable, at-least-once background work for [Open Mercato](https://github.com/open-mercato/open-mercato).

A job is a row in your database with a lease on it. A worker claims the lease, does a slice of
the work, and hands the rest back; if that worker dies, the lease expires and a reconciler
repairs the job. Nothing depends on a process remembering anything, which is what makes a
deploy, a crash and a network partition the same event.

## What it is for

Work that is too long to redo:

- a multi-day data import that a deploy would otherwise kill
- a job that stays `running` forever because the worker that held it is gone
- a transient error at hour nine throwing away the first eight
- two workers driving one job over a single cursor

## Install

```bash
yarn mercato module add @fullstackhouse/open-mercato-durable-work
```

`src/modules.ts`:

```ts
{ id: 'durable_work', from: '@fullstackhouse/open-mercato-durable-work' },
```

Then `yarn generate && yarn db:migrate`, and run the worker as its own process:

```bash
yarn mercato durable_work worker
```

Its own process on purpose: a slice can run for minutes, and hosting that inside the web
process means a deploy either kills work mid-batch or waits out a slice.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `DURABLE_WORK_TRANSPORT` | `pgboss` | `pgboss`, `bullmq` or `memory` |
| `DURABLE_WORK_REDIS_URL` | `QUEUE_REDIS_URL` | BullMQ only |
| `DURABLE_WORK_PGBOSS_SCHEMA` | `durable_work_boss` | keeps pg-boss's tables out of `public` |
| `DURABLE_WORK_TICK_MS` | `15000` | how often the reconciler runs |
| `DURABLE_WORK_DRAIN_TIMEOUT_MS` | `30000` | how long a SIGTERM waits for slices to hand back |

`pgboss` is the default because it needs nothing but the database you already have, and it is
the only transport that can enqueue a delivery inside your own transaction. Use `bullmq` if the
app already runs Redis. `memory` is for development and is refused in production.

## Declaring work

```ts
import { registry } from '@fullstackhouse/open-mercato-durable-work'

registry.register({
  kind: 'catalog.reindex',
  queue: 'durable-work.catalog',
  // A job nobody declares idempotent is parked for a human rather than re-run automatically.
  orphanPolicy: 'redrive',

  async step(ctx) {
    let done = ctx.checkpoint?.done ?? 0
    while (done < total) {
      // Stop at a boundary when the budget is spent or the process is shutting down.
      if (ctx.shouldYield()) return 'budget'

      await ctx.fencedWrite(async (tx) => {
        // Rolls back if the lease was lost, so this cannot outlive the right to write it.
      })

      done += 1
      await ctx.checkpoint_({ done }) // resume point, and a committed unit of work
    }
    return 'drained'
  },

  // Mirrors the terminal state onto your own row, in the same transaction.
  async onTransition(job, scope, tx) { /* … */ return { matched: 1 } },
  async onRedrive(job, scope, tx) { /* … */ return { matched: 1 } },
})
```

Throw `TransientError` (or anything unrecognised) to retry, `TerminalError` to stop, and
`UnrecoverableError` to stop and require `{ force: true }` before it can run again.

## Operating

```
GET    /api/durable_work/jobs           durable_work.view
GET    /api/durable_work/jobs/[id]      durable_work.view
POST   /api/durable_work/jobs/[id]/redrive   durable_work.operate
DELETE /api/durable_work/jobs/[id]      durable_work.operate
```

A re-drive refuses with a code rather than a generic failure, because the three refusals have
different answers: `lock_key_held` (wait for or cancel the job holding the key),
`not_redrivable` (completed and cancelled jobs are done), `unrecoverable_requires_force`.

`mercato durable_work reconcile` runs one repair pass and prints what it repaired.

## What it promises, and what it does not

**Promises.** No job stays `running` forever. A worker that lost its lease cannot write. Work
resumes from the last committed checkpoint. One live job per lock key per tenant.

**Does not.** Exactly-once execution: delivery is at-least-once, so a process killed between a
side effect and its checkpoint will redo that side effect. Make them idempotent, or put them
behind `onTransition`, which runs in the terminal transaction.

MIT. Part of [open-mercato-durable](https://github.com/fullstackhouse/open-mercato-durable).
