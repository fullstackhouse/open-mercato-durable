# 0003 — The leased tier lives in a package-owned table, not core's `progress_jobs`

Status: accepted (2026-09-07)

## Context

The archived spec (part 4) scored two homes for the leased tier: **Option A**, add the lease and
fencing columns to core's `progress_jobs`; **Option B**, a standalone durable-work record beside
it. Both satisfied every functional requirement. A was picked upstream only to avoid a second
record next to `progress_jobs`. Part 4 states the design is home-agnostic apart from which table
the columns land in.

We are building outside core. Option A is not available to us — we cannot add columns to a core
table from a package without a migration that fights core's own migration history.

## Decision

Re-home the design onto a package-owned table `durable_work_jobs`, shipped by the
`durable_work` module's own migration into `mikro_orm_migrations_durable_work`. Terminal
transitions are mirrored one-way into `progress_jobs` so the existing progress UI keeps working
unchanged (ADR 0002).

Mirror mode in v1 is **atomic only**: `onTransition` runs inside the terminal transaction, and a
failure rolls the transition back and increments `mirror_attempts`. The spec's `deferred` mode
and the reconciler's mirror-retry query (Q5) are out of v1; the columns are kept so they can be
turned on without a migration.

## Consequences

- Zero core changes to adopt, and swapping the packages out leaves core's tables as they were.
- Two rows per tracked job. The mapping is one-way and narrow — status, counts, message.
- Core's progress read path fails a `running` row whose heartbeat is older than 60 s. A durable
  job waiting out a retry backoff will trip that, so the progress row can say "failed" while the
  job is healthy. It self-heals on the next claim because core's `startJob` admits
  `failed → running`. Mitigation: write a "waiting for redelivery" message at yield and fail.
- If upstream ever adopts the tier into `progress`, this package becomes the reference
  implementation rather than a competitor: the mechanism is unchanged, only the home moves.
