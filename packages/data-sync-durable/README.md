# @fullstackhouse/open-mercato-data-sync-durable

A drop-in replacement for Open Mercato's core `data_sync` module that runs sync runs as durable
work. Same tables, same REST API, same adapter contract, same events, same UI.

## The problem

A `data_sync` run is one long stream over a cursor. On core's engine:

- a deploy in the middle of a multi-day backfill kills the run
- a worker that dies leaves the run `running` forever
- one transient error at hour nine fails the whole run, throwing away hour one through eight

## Install

```bash
yarn mercato module add @fullstackhouse/open-mercato-durable-work
yarn mercato module add @fullstackhouse/open-mercato-data-sync-durable
```

<details>
<summary>Installing straight from the repository, without a registry</summary>

Both packages build on pack, so a git dependency delivers a built package:

```yaml
# .yarnrc.yml
approvedGitRepositories:
  - "ssh://git@github.com/fullstackhouse/*"
```

```bash
REPO="git+ssh://git@github.com/fullstackhouse/open-mercato-durable.git"
yarn add \
  "@fullstackhouse/open-mercato-durable-work@$REPO#workspace=@fullstackhouse/open-mercato-durable-work" \
  "@fullstackhouse/open-mercato-data-sync-durable@$REPO#workspace=@fullstackhouse/open-mercato-data-sync-durable"
```

Add both, always. `durable-work` is a **peer** of this package, and installing exactly one copy
of it is not a tidiness preference: it exports a process-wide registry, and a second copy would
mean kinds register into one and the worker reads the other — silently.

Pin a commit with `&commit=<sha>` if you want a git dependency to be reproducible; a bare
branch reference re-resolves.
</details>

`src/modules.ts` — the whole change is one `from`:

```ts
{ id: 'durable_work', from: '@fullstackhouse/open-mercato-durable-work' },
{ id: 'data_sync',    from: '@fullstackhouse/open-mercato-data-sync-durable' },  // was '@open-mercato/core'
```

Then `yarn generate && yarn db:migrate` — a no-op for existing `data_sync` history, because the
migration classes keep core's names — and run `yarn mercato durable_work worker`.

Reverting is the same line.

## What changes

A run gets a lease. It commits its cursor under that lease, hands back at a batch boundary when
its slice budget is spent or the process is stopping, and resumes from the committed cursor. A
transient error retries the slice instead of failing the run. A worker that dies is noticed by
the reconciler within about a minute. One live run per integration, entity and direction.

## What does not change

Your adapters. They import core's deep paths, which this package re-exports, so there is one
process-wide adapter registry and one entity class. `sync_excel`, `sync_akeneo` and anything you
wrote keep working untouched — including runs they start themselves, which are adopted when the
queue delivers them.

The UI, the REST API, the events and the ACL features are core's, unchanged.

## How it works

It does **not** fork core's engine. Core's engine already survives being displaced by another
worker: it asks a cancellation question at every batch boundary, and it stays silent when a
terminal write is refused. This package answers those two questions differently and routes the
cursor commit through the lease fence. See
[docs/adr/0004](https://github.com/fullstackhouse/open-mercato-durable/blob/main/docs/adr/0004-fork-slice-engine.md).

Every seam it relies on is asserted against the installed core in CI, on both the released and
the development channel, so an upstream change fails there rather than in your app.

## Versioning

One release line per core minor: `data-sync-durable 0.7.x` mirrors `@open-mercato/core 0.7.x`.
Bump both together. Hosts that have ejected `data_sync` into `@app` are out of scope.

MIT. Part of [open-mercato-durable](https://github.com/fullstackhouse/open-mercato-durable).
