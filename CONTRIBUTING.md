# Contributing

## Setup

Node 24.x, yarn 4 (via corepack), Docker.

```bash
docker compose up -d                # postgres :5480 · redis :6480 (non-default on purpose)
./scripts/sandbox-env.sh            # .env from the template, with generated secrets
yarn install
yarn build:packages
yarn workspace sandbox generate     # the app registry is generated from the packages' dist
yarn initialize                     # migrations + seed data
yarn dev                            # http://localhost:3000/backend
yarn dev:worker                     # the durable worker, second terminal
```

Log in as `superadmin@acme.com` / `secret` (form-encoded if you are calling the API by hand —
`/api/auth/login` does not accept JSON).

`sandbox-env.sh` generates the secrets rather than committing them: the template's placeholders
are fine for `yarn dev`, but the e2e runner builds and starts the app in production mode, where
core refuses to boot on a secret published in its own examples. Re-running it with `--force`
rotates `TENANT_DATA_ENCRYPTION_FALLBACK_KEY`, which makes an existing database's encrypted
columns unreadable — re-run `yarn initialize` after.

## The loop

`build:packages → generate → typecheck/test`. `generate` reads the built `dist/`, and both
typecheck and the app read what `generate` wrote, so skipping a step gives confusing errors
rather than obvious ones. `yarn watch` keeps the first step live while you work.

Before pushing:

```bash
yarn typecheck && yarn lint && yarn test && yarn gen:mirror:check && yarn check:dep-versions
yarn test:harness                   # DURABLE_TRANSPORT=memory|bullmq|pgboss
yarn test:integration:ephemeral     # e2e; brings up its own throwaway Postgres + app
```

## Where a change belongs

| Kind of change | Where the test goes |
|---|---|
| Mechanism behaviour under failure (kills, stalls, lost leases, replicas) | `harness/src/suites/` |
| A transport implementing the contract | the shared conformance suite — it must pass on all three |
| User-visible contract (a route, a page, a status the UI shows) | `src/modules/<id>/__integration__/TC-*.spec.ts` |
| Pure logic | `*.test.ts` next to the code |

New behaviour lands with a test that fails without it. A scenario that passes on one transport
and not another is a bug, not a caveat.

## The `data_sync` mirror

`packages/data-sync-durable/src/modules/data_sync/**` and `packages/data-sync-durable/generated/**`
are produced by `scripts/gen-mirror.mjs` from the installed `@open-mercato/core`. Do not edit
them. To own a file, add its path to `mirror.replaced.json` and write it — the manifest then
records the hash of the core file you shadow, so `gen:mirror --check` tells you when core
changes underneath you. Read `docs/adr/0006-drop-in-data-sync.md` first; it records which
contracts a re-export stub can and cannot carry, and why.

After bumping `@open-mercato/*`: `yarn gen:mirror`, then review the diff of every replaced file
against core before committing.

## Commits and releases

Conventional Commits. Anything that changes a published package needs a changeset
(`yarn changeset`). The packages version independently; `data-sync-durable`'s minor tracks the
core minor it mirrors (`0.7.x` ↔ core `0.7.x`), so a core bump is a release, not a patch.
