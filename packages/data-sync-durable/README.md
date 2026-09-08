# @fullstackhouse/open-mercato-data-sync-durable

A drop-in replacement for Open Mercato's core `data_sync` module that runs sync runs as durable
work. Same tables, same REST API, same adapter contract, same events, same UI.

## The problem

A `data_sync` run is one long stream over a cursor. On core's engine:

- a deploy in the middle of a multi-day backfill kills the run
- a worker that dies leaves the run `running` forever
- one transient error at hour nine fails the whole run, throwing away hour one through eight

## Install

The packages are not on npm yet, so install them from this repository. Both build on pack, so a
git dependency delivers a built package, and yarn pins the resolved commit in your lockfile.

```yaml
# .yarnrc.yml
approvedGitRepositories:
  - "https://github.com/fullstackhouse/*"
```

```bash
REPO="git+https://github.com/fullstackhouse/open-mercato-durable.git"
yarn add \
  "@fullstackhouse/open-mercato-durable-work@$REPO#workspace=@fullstackhouse/open-mercato-durable-work" \
  "@fullstackhouse/open-mercato-data-sync-durable@$REPO#workspace=@fullstackhouse/open-mercato-data-sync-durable"
```

HTTPS needs no credentials, which is what makes this work in CI without a deploy key. Add
`&commit=<sha>` to pin explicitly; otherwise yarn records the resolved commit in the lockfile
and re-resolves only when you ask it to.

**Add both, always.** `durable-work` is a *peer* of the adopter, and installing exactly one copy
is not tidiness: it exports a process-wide registry, and a second copy would mean job kinds
register into one while the worker reads the other — silently.

Once the packages are published this becomes `yarn mercato module add @fullstackhouse/…`.

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
