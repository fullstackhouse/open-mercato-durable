# Archived upstream spec series — "background work" (8 parts)

Vendored verbatim from `open-mercato/open-mercato` at commit `205fbd53fd97` (2026-08-25,
"docs(specs): round 12c"), the last revision of the full **leased-tier** design before upstream
PR #5450 was restructured into the staged v5 series. This is the reference design for the
`durable-work` package in this repo. Parts 1–3 are the problem statement and requirements;
part 4 the decision record; part 5 the queue transport contract the design assumed; part 6 the
mechanism; part 7 the `data_sync` adoption; part 8 the operator surface.

These files are **not edited** here. Deviations from them are recorded in `docs/adr/`.

## Re-homing map (part 6 → this repo)

The archived design grows core `progress_jobs` into the durable-work record. Here the record
is a table owned by the `durable_work` module, `durable_work_jobs`, and `progress_jobs` stays
presentation-only (mirrored one-way on terminal transitions). Vocabulary and invariants are
kept; names map as follows.

| Archived (part 6) | Here |
|---|---|
| `progress_jobs` + 20 additive columns | `durable_work_jobs` (all columns, plus `input`, `checkpoint`, `idempotency_key`, `progress_job_id`, `error_class`) |
| `ProgressService` leased members (`createLeasedJob`, `claim`, `heartbeatLease`, `yieldSlice`, `failSlice`, `completeSlice`, `failSliceTerminal`, `releaseLease`, `redrive`) | `DurableWorkService` (`start`, `claim`, `heartbeat`, `yieldSlice`, `failSlice`, `complete`, `failTerminal`, `releaseLease`, `redrive`) |
| `LeasedJobKind` + `job-kinds.ts` auto-discovery | `KindDefinition` + `defineKind()` / `registerKinds()` (explicit registration from the owning module's `di.ts`) |
| `runSlice` worker factory in `progress` | `runSlice` in `durable-work/src/core/run-slice.ts`, bound per queue by `bindKinds()` |
| reconciler queries Q1–Q5 in `progress-reconcile` | `reconcileOnce()` in `durable-work/src/core/reconciler.ts`; **Q5 (deferred mirror) is out of v1** |
| part 5 transport additions (`queueJobId`, `signal`, `close({timeoutMs})`, `upsertRepeatable`, `yield`) | `TransportAdapter` owned by this package (bullmq-direct, pg-boss, memory) — `@open-mercato/queue` is not modified |
| delivery id `pj-<id>-<seq>-<redrives>` | `dw-<id>-<seq>-<redrives>` |
| `progress.job.*` leased events | `durable_work.job.*` |
| `POST /api/progress/jobs/[id]/redrive` | `POST /api/durable_work/jobs/[id]/redrive` |
| part 7: `data_sync` adopts via core changes | `data-sync-durable`: a drop-in package module with id `data_sync` (see ADR-0006) |
| part 8: operator pages in `progress/backend` | out of v1 (API + CLI only) |

## Files

- `2026-08-21-background-work-01-data-sync-problems.md`
- `2026-08-21-background-work-02-sibling-modules-problems.md`
- `2026-08-21-background-work-03-common-problems-and-requirements.md`
- `2026-08-21-background-work-04-solution.md`
- `2026-08-21-background-work-05-queue-transport-contract.md`
- `2026-08-21-background-work-06-leased-jobs-in-progress.md`
- `2026-08-21-background-work-07-data-sync-adoption.md`
- `2026-08-21-background-work-08-operator-surface.md`

Upstream PR: https://github.com/open-mercato/open-mercato/pull/5450 (the later v5 revision
narrows the series to `data_sync` hardening without the leased tier; that revision is not the
basis for this repo).
