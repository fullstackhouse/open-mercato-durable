# open-mercato-durable

Durable, at-least-once background work for [Open Mercato](https://github.com/open-mercato/open-mercato) apps, by [Full Stack House](https://fullstack.house).

| Package | What it is |
|---|---|
| [`@fullstackhouse/open-mercato-durable-work`](packages/durable-work) | The mechanism: a leased job record in your app's Postgres with epoch fencing, bounded resumable slices, a server-side reconciler, fenced cancel, an operator API and CLI. Transport is pluggable: BullMQ or pg-boss. |
| [`@fullstackhouse/open-mercato-data-sync-durable`](packages/data-sync-durable) | A **drop-in replacement for core's `data_sync` module** that runs sync runs as durable work. Same tables, REST API, adapter contract, events and UI. Swap one line in `modules.ts`. |

Why: a deploy kills a multi-day sync run; a run stays `running` forever after a worker dies; one transient error throws away days of committed work; two runs start on one cursor. The problem statement and the reviewed design live in [`docs/specs/archived-upstream`](docs/specs/archived-upstream/README.md); the decisions taken here are in [`docs/adr`](docs/adr).

## Status

Pre-release. See [`docs/roadmap.md`](docs/roadmap.md) for the phase we are in and the MVP line.

## Using the packages

Not on npm yet — install from this repository. Both build on pack, so a git dependency delivers
a built package, and HTTPS needs no credentials, which is what makes it work in CI without a
deploy key.

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

Add both: `durable-work` is a peer of the adopter, and exactly one copy must be installed —
it exports a process-wide registry, and a second copy would leave job kinds registered in one
while the worker reads the other.

`src/modules.ts`:

```ts
{ id: 'progress',     from: '@open-mercato/core' },
{ id: 'durable_work', from: '@fullstackhouse/open-mercato-durable-work' },
{ id: 'data_sync',    from: '@fullstackhouse/open-mercato-data-sync-durable' },   // was '@open-mercato/core'
```

Then `yarn generate && yarn db:migrate`, set `DURABLE_WORK_TRANSPORT=pgboss|bullmq`, and run the durable worker as its own process: `yarn mercato durable_work worker`. Grant `durable_work.operate` to the roles that may re-drive or cancel jobs. Swapping back to core is the same one line.

Per-package READMEs carry the full configuration reference.

## Developing in this repo

The repo follows [`open-mercato/official-modules`](https://github.com/open-mercato/official-modules): yarn 4 workspaces, an `apps/sandbox` Open Mercato app wired to the workspace packages (no publish step), per-module Playwright specs under `__integration__/`, and the OM CLI's ephemeral runner for e2e.

```bash
docker compose up -d                      # postgres + redis (+ verdaccio)
cp apps/sandbox/.env.example apps/sandbox/.env
yarn install
yarn build:packages && yarn generate && yarn initialize
yarn dev                                  # sandbox on http://localhost:3000/backend
yarn dev:worker                           # the durable worker, in a second terminal
```

| Task | Command |
|---|---|
| Unit tests (packages) | `yarn test` |
| Failure harness (real PG/Redis, kills, replicas) | `DURABLE_TRANSPORT=pgboss yarn test:harness` (or `bullmq`, `memory`) |
| E2E against a disposable sandbox | `yarn test:integration:ephemeral` |
| Keep a disposable sandbox up for manual QA | `yarn test:integration:ephemeral:start` (login `admin@acme.com / secret`) |
| Regenerate the `data_sync` mirror after a core bump | `yarn gen:mirror` (CI runs `gen:mirror:check`) |
| Pin the sandbox and dev deps to an OM channel | `yarn platform:sync --channel latest\|develop` |
| Publish preview builds to local Verdaccio | `yarn registry:up && yarn publish:preview` |
| Recreate the sandbox from the current template | `yarn sync:sandbox [develop]` |

Layout: `packages/*` publishable packages · `apps/sandbox` example app · `harness/` failure suite (not published; deliberately outside `apps/` — the OM CLI treats every `apps/*` directory as a candidate app) · `docs/` specs, ADRs, roadmap · `.ai/qa` e2e discovery and Playwright config.

## Releasing

Automatic. Every merge to `main` that changes something a user can see publishes both packages
at one version, computed from the conventional commits since the last tag, over npm trusted
publishing — no token is stored anywhere, and the artifacts carry provenance. `yarn
release:dry-run` reports what a merge would release without publishing.

The two packages release in lockstep at one version on purpose: the mirror is generated against
a pinned core, the compat probe asserts the seams the adopter decorates, and the harness
exercises both, so a change to either is only ever validated against the other. See
[`.releaserc.md`](.releaserc.md), which also covers the one-time bootstrap each package needs
before automation can take over.

## License

MIT
