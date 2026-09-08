# 0004 — Fork `data_sync`'s batch loop into a slice engine, guarded by a hash probe

Status: accepted (2026-09-07)

## Context

Durable `data_sync` needs the import/export loop to do three things core's loop does not: stop
at a batch boundary when the slice budget is spent and hand the rest back, commit each batch's
cursor through `fencedWrite` so a stale worker's write is refused, and let a transient error at
one batch be retried without failing the run.

Wrapping `runImport` from outside cannot deliver any of them: the engine catches its own errors
and writes the terminal state inside its own `catch`, so by the time a decorator sees anything,
the run is already marked failed and the loop is gone. The choices were therefore to decorate
the *run service* to refuse that terminal write and re-drive from the committed cursor, or to
fork the loop.

Decorating the run service works, but it turns every batch error into a full re-drive through
the transport, and it still cannot yield mid-run — the loop has no yield point to add. Only a
fork gets slices.

## Decision

Fork core's batch loop into `packages/data-sync-durable/src/engine/slice-engine.ts`. It keeps
core's adapter contract, batch streaming, run-parameter and cursor helpers by importing them;
what is forked is the loop body and its error handling. Every forked helper carries a comment
naming the core file and line range it mirrors.

Drift is made loud, not assumed: `mirror.manifest.json` records the hash of every core file we
shadow, `gen:mirror --check` runs in CI and in `prebuild`, and a boot-time version guard throws
if the installed `@open-mercato/core` minor differs from the mirrored one.

Asking upstream for a hook that would make the fork unnecessary is a separate, later
conversation. It is not a prerequisite and not on this roadmap.

## Consequences

- ~400 forked lines that must be diffed against core once per OM minor. This is the single
  largest maintenance line item in the repo and it is accepted deliberately.
- The fork is the only thing that works on 0.7.x, which is what our consumers run today.
- Because the fork is narrow and hash-guarded, a core change to the loop fails CI with the file
  name rather than silently changing behaviour in production.
