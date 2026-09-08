# 0001 — A package-owned transport adapter, with three implementations

Status: accepted (2026-09-07)

## Context

The mechanism needs a way to get "run a slice of job J" from wherever a job was created to
whichever worker process picks it up, and to get it *again* if that process dies mid-slice.
Four candidates were on the table.

**`@open-mercato/queue` as-is.** It is what every OM worker already uses, so it costs nothing
to adopt. But on `develop` its enqueue options carry only `delayMs` — no caller-supplied job
id, so a re-drive cannot be deduplicated; the job context has no `AbortSignal`, so a slice
cannot be asked to stop at a batch boundary on SIGTERM; there is no bounded `close()`, so a
deploy is a SIGKILL; and its local strategy is a JSON file that cannot exhibit any production
failure mode, so the conformance suite would only ever prove one of the two paths. Fixing this
properly is upstream PR territory (spec part 5) and is exactly the change that is stuck.

**pg-boss.** 12.30.0 accepts a caller-supplied db client on `send`, so a job row can be
enqueued inside the same transaction as the domain rows — the one thing neither BullMQ nor the
OM queue can do. It also has `singletonKey`, `startAfter`, a retry policy, `expireInSeconds`
and heartbeat-based lease renewal (`heartbeat_seconds`, `touchJobs`, `failJobsByHeartbeat`).

**Graphile Worker.** Rejected: it takes its lock once at fetch with a fixed four-hour timeout
and has no renewal. Multi-day work is the whole point here, so the lease shape is wrong.

**BullMQ.** Already a peer dependency of every OM app that runs the Redis strategy, and it has
everything the mechanism needs at the transport level today: deterministic `jobId`, the
three-argument processor (so a real `AbortSignal`), `moveToDelayed` + `DelayedError` for a
hand-back that does not spend a retry attempt, and job schedulers for the reconciler tick.
BullMQ 6's new Postgres backend was considered and **rejected for v1**: it cannot enqueue on
the caller's transaction, and 6.0 is its first release.

The decisive fact about all four: **none of them fences.** pg-boss completes a job on
`state = 'active'` alone; there is no epoch or version column in either pg-boss or Graphile.
A worker that lost its lease and then writes is undetected by the transport in every case.
Fencing has to live in our own record regardless of what carries the delivery, which means the
transport is genuinely a replaceable detail and not the core of the design.

## Decision

Define a package-owned `TransportAdapter` interface — `enqueue`, `remove`, `getState`,
`upsertTick`, `bind`, `close` — and ship three implementations:

- **memory** — unit tests and fault injection. Not for production.
- **bullmq** — production default where an OM app already runs Redis. Deterministic delivery
  ids, native hand-back via `moveToDelayed`, signal from the 3-arity processor.
- **pgboss** — production option with no Redis, and the only one with transactional enqueue
  (`send(..., { db })` on the caller's transaction). Hand-back is emulated: send-next then
  complete-current.

Lease, epoch, fencing, slices, budgets and the reconciler live **above** every adapter. One
conformance suite runs against all three; an adapter is done when it passes it.

## Consequences

- The mechanism can promise the same semantics on Redis and on Postgres-only deployments, and
  we never need an upstream queue change to ship.
- Two production adapters is more surface than one. The conformance suite is what keeps that
  honest; a scenario that only passes on one adapter is a bug, not a caveat.
- `pgboss`'s hand-back changes `queue_job_id` per slice, and `remove`/`getState` are coupled to
  pg-boss 12's `job` table shape. Pinned as `>=12 <13`.
- On pgboss the reconciler tick is a per-process timer with `singletonSeconds`; with zero
  workers up there is no tick. Same stated failure mode as the archived spec.
- Apps end up running two worker processes (the OM queue worker and the durable worker) until a
  transport contract exists upstream. Deployment templates must say so.
