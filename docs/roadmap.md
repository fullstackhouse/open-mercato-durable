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
| 1 | `schema.ts`, `sql.ts`, `store.ts`, memory transport, harness env | store tests on real PG (epoch refusal, seq/redrives refusal, verdict in-statement, lock-key 409, idempotency) | |
| 2 | registry, `runSlice`, terminal transition, taxonomy, conformance on memory | duplicate delivery refused; stale writer fenced; crash between writes resumes; terminal + mirror; 3 yields spend no retry | |
| 3 | reconciler, worker bind/tick/drain, harness replicas | SIGKILL mid-slice re-driven; cancel-then-kill ends cancelled; poison park; lost hand-back re-driven; two reconcilers partition | |
| 4 | bullmq adapter | full harness suite on bullmq; SIGTERM drain; tick survives FLUSHALL | |
| 5 | pgboss adapter | full harness suite on pgboss; transactional start rollback leaves nothing | |
| 6 | OM module surface (migration, DI, routes, CLI, events, progress mirror, in-process worker), `TC-DW-00x` | unit matrix; e2e in sandbox | |
| 7 | `data-sync-durable` drop-in (REPLACED set, kind, slice engine, migrations re-export, compat probe), sandbox `example_sync`, `TC-DSD-00x` | harness data-sync suite; e2e in sandbox; compat on `latest` + `develop` | |
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

**Known sandbox quirks**, neither caused by our packages:

- `POST /api/auth/login` accepts form encoding, not JSON; the seeded `secret` password does not
  satisfy the app's own password policy, so `mercato auth set-password` rejects re-setting it.
- Next must be pinned to exactly the version `apps/sandbox` uses. A split (our packages had
  16.1.7 while the sandbox had 16.3.0) makes yarn install two copies and Turbopack panics during
  middleware compilation with no hint at the cause. `yarn check:dep-versions` now fails on it.
