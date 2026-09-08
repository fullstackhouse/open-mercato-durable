# open-mercato-durable — agent instructions

Two FSH-owned Open Mercato module packages plus the app and harness that prove them:

| Path | What it is |
|---|---|
| `packages/durable-work` | `@fullstackhouse/open-mercato-durable-work` — the mechanism (module id `durable_work`) |
| `packages/data-sync-durable` | `@fullstackhouse/open-mercato-data-sync-durable` — a **drop-in for core's `data_sync`** (module id `data_sync`) |
| `apps/sandbox` | a real Open Mercato app, wired to the workspace packages, for local dev and e2e |
| `harness/` | node-level failure suite (kills, stalls, replicas). **Not** under `apps/` — see below |
| `docs/adr` | the decisions; read these before changing a design |
| `docs/specs/archived-upstream` | the reviewed 8-part spec series this is built from, vendored verbatim |

Start with [`docs/roadmap.md`](docs/roadmap.md): it names the current phase and its acceptance
bar. One phase, one PR.

## Rules that bite

- **`apps/` holds exactly one app.** The OM CLI resolves a monorepo's app directory as the first
  non-dot, non-`docs` entry of `apps/`, so a second directory there silently steals every
  `mercato` command. That is why the harness lives at the repo root.
- **Run `mercato` from `apps/sandbox`**, not from the repo root. The root `yarn generate` etc.
  delegate through `yarn workspace sandbox`.
- **Never hand-edit `packages/data-sync-durable/src/modules/data_sync/**` or `generated/**`.**
  They are produced by `scripts/gen-mirror.mjs` from the installed `@open-mercato/core`. To
  take ownership of a file, add it to `mirror.replaced.json` and write it; `gen:mirror --check`
  then flags when core changes the file you shadow. CI and `prebuild` run the check.
- **`require.resolve('@open-mercato/<pkg>/package.json')` does not work.** Their `exports` maps
  rewrite `./*.json` to `./src/*.json`. Resolve the entry point and walk up to the manifest —
  `gen-mirror.mjs` and `config/vitest.om-aliases.ts` both do this.
- **Core's sources import every optional platform package by name.** Typechecking anything that
  imports `@open-mercato/shared` pulls `core/src/bootstrap.ts` in, so every package the sandbox
  enables must resolve from the **root** `node_modules` — that is why `@open-mercato/search`
  and `@open-mercato/scheduler` are root devDependencies. `yarn platform:sync` keeps the pins
  aligned.
- **Local infra is on 5480 (Postgres) and 6480 (Redis)**, not the defaults — this machine runs
  other Open Mercato apps. `docker compose up -d`.
- **Yarn, not pnpm.** The OM tooling and the sandbox assume yarn 4; node 24.x.

## What the mirror can and cannot express

The `data_sync` drop-in ships one generated re-export stub per core file. The OM generator reads
some things by importing a module and some by parsing its text; only the second kind needs help.
`docs/adr/0006-drop-in-data-sync.md` records the measured result and the three exceptions
`gen-mirror` handles (HTTP method names, route `metadata` literals, the entity descriptor).
`packages/data-sync-durable/src/compat/mirror-shape.test.ts` asserts all three — if you change
the stub format, that test is the contract.

## Checks

```bash
yarn build:packages && yarn generate && yarn typecheck && yarn lint && yarn test
yarn gen:mirror:check
yarn test:harness                       # DURABLE_TRANSPORT=memory|bullmq|pgboss
yarn test:integration:ephemeral         # e2e against a disposable sandbox (needs Docker)
```

`yarn generate` must be run after `build:packages` and before `typecheck`: the sandbox's
`.mercato/generated` is an input to both.

## Conventions

- Conventional Commits. Changesets for anything that changes a published package.
- Specs and decisions are markdown in `docs/`, not comments in code.
- New behaviour lands with a test that fails without it. Failure-mode behaviour lands in
  `harness/`, user-visible behaviour in `__integration__/` specs.
