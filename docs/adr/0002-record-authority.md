# 0002 — `durable_work_jobs` is the authority for liveness; domain rows keep domain state

Status: accepted (2026-09-07)

## Context

Adopting the mechanism for `data_sync` means a single sync run is described by three rows:
`sync_runs` (the domain record, with the cursor), the durable job, and `progress_jobs` (what
the UI polls). Without a rule about which one is true, every one of them becomes a place where
a run can be "running" while the other two disagree — which is the class of bug the whole
exercise exists to remove.

## Decision

- **`durable_work_jobs` is the authority for liveness**: status, lease owner, lease epoch,
  heartbeat, retry and re-drive budgets, cancellation intent. Only the mechanism writes it.
- **The domain row keeps domain state**: `sync_runs` owns the cursor, counts and the run's own
  status. The adopter maps durable terminal states onto it inside the terminal transaction.
- **`progress_jobs` is presentation**, mirrored one way. Nothing reads it to make a decision.

Corollary: "is this run alive?" is answered by the lease on the durable row and nothing else.

## Consequences

- A stale writer cannot resurrect a run: every domain write goes through `fencedWrite`, which
  re-asserts the epoch inside the same transaction.
- The progress row can lag or briefly lie (see ADR 0003's consequences); it never drives.
- Later adopters get the same rule for free, which is what makes `progress` eventually
  reducible to a façade over the durable record rather than a second clock.
