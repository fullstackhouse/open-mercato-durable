# Roadmap

Status per phase is tracked here; each phase is one PR. "Green when" is the acceptance bar.

## MVP line (v0.1 of `durable-work`)

**In**: claim / lease / heartbeat / epoch fence; `fencedWrite`; `checkpoint`; reconciler
(Q3 → Q1 → Q2, `SKIP LOCKED`); slices with hand-back that never spend a retry; `lock_key`
single-runner + `idempotency_key`; error taxonomy (transient default / terminal / unrecoverable)
with in-statement verdicts; fenced cancel; operator API + CLI; lifecycle events; three transport
adapters (memory, bullmq, pgboss); conformance harness; 3-replica kill soak.

**Out** (each needs an ADR to come in): waiting / timers, delayed start, parent-child
aggregation, deferred mirror mode (Q5), operator UI pages, retention of tracked `progress_jobs`,
a `workflows` adopter.

## Phases

| # | Deliverable | Green when | Status |
|---|---|---|---|
| 0 | Repo scaffold (official-modules shape), sandbox app with `data_sync` swapped to our package, harness skeleton, QA discovery, platform-sync, Verdaccio, changesets, vendored specs, ADRs, CI lanes; **spike**: `gen-mirror` v0 with pure re-export stubs, verified through `yarn generate` | packages lane green; sandbox boots with core-equivalent `data_sync` served from our package; `TC-DW-000` + `TC-DSD-000` pass; harness runs one test per transport | scaffold + spike done; e2e specs pending |
| 1 | `schema.ts`, `store.ts`, memory transport, harness env | store tests on real PG (epoch refusal, seq/redrives refusal, verdict in-statement, lock-key 409, idempotency) | done — 39 tests, mutation-checked |
| 2 | registry, `runSlice`, terminal transition, taxonomy | duplicate delivery refused; stale writer fenced; crash between writes resumes; terminal + mirror; 3 yields spend no retry | done — 63 harness tests |
| 3 | reconciler, worker bind/tick/drain, harness replicas | SIGKILL mid-slice re-driven; cancel-then-kill ends cancelled; poison park; lost hand-back re-driven; two reconcilers partition | done — 83 harness tests, incl. real SIGKILLed child processes |
| 4 | bullmq adapter | full harness suite on bullmq; SIGTERM drain; tick survives FLUSHALL | done — conformance + tick survives FLUSHALL |
| 5 | pgboss adapter | full harness suite on pgboss; transactional start rollback leaves nothing | done — conformance + transactional start, mutation-checked |
| 6 | OM module surface (entity, migration, DI, operator API, CLI, events, progress mirror) | done — exercised against a booted sandbox; `TC-DW-00x` e2e specs pending |
| 7 | `data-sync-durable` drop-in: decorated run service, kinds, REPLACED set (di, start-run, workers), adopt-on-delivery, compat probe, sandbox `example_sync` | demonstrated against a booted sandbox — see below; 9 e2e specs green in the ephemeral runner | done |
| 8 | soak, install lane, docs, release 0.1.0, repo public | soak invariants; install lane green on both channels | |
| 9 | groomershop staging → prod; `scheduler-durable` | separate plan | |

## Phase 0 — where it stands

**Done.** Repo, both packages, the sandbox wired to them, harness skeleton, ADRs 0001–0006, CI
lanes, docs. The mirror spike is resolved and recorded in ADR 0006: pure re-export stubs work,
with three exceptions `gen-mirror` now handles (HTTP method names, route `metadata` literals,
the entity descriptor). Verified end to end against a real database and a booted app:

- `yarn workspace sandbox generate` produces output **identical to core's** for every generated
  artifact, modulo the package specifier and one extra Tailwind `@source` line.
- Migrations run under core's class names into `mikro_orm_migrations_data_sync`; `sync_runs`,
  `sync_cursors`, `sync_mappings`, `sync_schedules` exist on a database initialised through our
  package.
- Every core `data_sync` route is registered and enforces its ACL (401 unauthenticated, 200
  after login); `/api/data_sync/runs` returns the real paginated list and `/api/data_sync/options`
  returns the adapter registry **including `sync_excel`** — the core module that depends on
  `data_sync` by id and imports core's deep paths, sharing one process-wide registry through
  our stubs.
- `build:packages`, `typecheck`, `lint`, `test`, `gen:mirror:check`, `check:dep-versions` and the
  harness smoke suite are green.

**Not yet.** The `example_sync` sandbox module and the `TC-DW-000` / `TC-DSD-000` integration
specs. `TC-DW-000` (`GET /api/durable_work/jobs` → 200) cannot pass before phase 6, which is
when `durable_work` grows routes — the roadmap row above overstated what phase 0 can prove, and
the operator-API spec moves to phase 6 where it belongs.

The ephemeral e2e environment also builds, boots and serves `data_sync` from our package
(`sync_excel` present in the adapter registry there too), and all seven CI lanes are green.

**Known sandbox quirks**, none caused by our packages:

- The template's `.env.example` ships `JWT_SECRET=change-me-dev-secret`, which core refuses to
  boot on in production mode — so the ephemeral runner, which builds and starts a production
  app, cannot use the template as-is. `scripts/sandbox-env.sh` generates the secrets instead.
- `POST /api/auth/login` accepts form encoding, not JSON; the seeded `secret` password does not
  satisfy the app's own password policy, so `mercato auth set-password` rejects re-setting it.
- Next must be pinned to exactly the version `apps/sandbox` uses. A split (our packages had
  16.1.7 while the sandbox had 16.3.0) makes yarn install two copies and Turbopack panics during
  middleware compilation with no hint at the cause. `yarn check:dep-versions` now fails on it.

## Phase 7 — what has been demonstrated

Against a booted sandbox with `data_sync` served from this package and a real
`mercato durable_work worker` process:

- `POST /api/data_sync/run` creates a `sync_runs` row **and** a durable job carrying the
  single-runner lock key, the run's idempotency key and its subject.
- The worker runs the run through **core's own engine**, and it completes: `sync_runs` is
  `completed` with its batches and record counts, the durable job is `completed`, and
  `domain_mirrored_at` is set — the two rows moved together.
- **A transient failure no longer throws the run away.** With a failure injected at batch 2:
  `slice_failed … "Scripted failure at batch 2"` followed by `job_completed` for the same job.
  The run resumed from its committed cursor, finished the remaining batches, and ended with
  `consecutive_failures` back at 0. That is fsh#101.
- A second start for the same integration, entity and direction is refused with 409.
- The operator API shows live counts (`6 of 6`) for the job.

Four bugs this found, all in the Open Mercato adapter layer and none reachable from the
harness (which talks to Postgres directly):

1. **`mikroExecutor.transaction` was not transactional.** MikroORM's `connection.execute` takes
   the transaction context as its fourth argument; without it every statement ran on a pooled
   connection outside the transaction. Nothing failed — it simply was not atomic, so
   `fencedWrite` no longer rolled back a stale worker's writes and a terminal transition no
   longer moved both rows together.
2. **`rowCount` counted returned rows.** An `UPDATE` without `RETURNING` returns none, so every
   domain mirror reported `matched: 0` — which is treated exactly like a throw, over a write
   that had already landed.
3. **The decorated services carried only the overridden methods**, so core's engine failed at
   its first undecorated call (`progressService.startJob is not a function`).
4. **The module CLI used the wrong shape**, so `mercato durable_work worker` did not exist.
5. **`insertJob` queried after a constraint violation.** In Postgres a failed statement aborts
   the whole transaction, so the error path that looked up the existing job or the lock holder
   worked on an autocommit connection and failed with "current transaction is aborted" on the
   caller's — which is exactly where `start` is meant to be called. It now checks first and
   lets the unique indexes close the race.
6. **Replacing `lib/start-run.ts` redirected nobody.** The mirror's stubs mean core's own route
   imports core's own sibling, so a run started through `/api/data_sync/run` never reached the
   durable start path. The route is now wrapped — not copied — so the job is created alongside
   the run, with core's queue delivery still the backstop if that fails.
