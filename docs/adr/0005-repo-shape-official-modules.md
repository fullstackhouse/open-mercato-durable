# 0005 — Mirror `open-mercato/official-modules`' repo shape

Status: accepted (2026-09-07)

## Context

We need an example OM app to develop and e2e-test the packages against: a module package cannot
be exercised meaningfully in isolation, because most of what can break is how the OM CLI's
generator, DI container, route registry and migration runner treat it. Upstream already solved
this for its own module packages in `open-mercato/official-modules`.

That repo uses yarn 4 workspaces plus turbo; an `apps/sandbox` app generated from
`create-mercato-app` and wired to the workspace packages *by name, with no publish step*; an
esbuild `build.mjs` with the multi-star `exports` map the OM CLI's `module add` and `eject`
expect; per-module Playwright specs under `src/modules/<id>/__integration__/` auto-discovered by
`.ai/qa/helpers/integration-discovery.ts`; `yarn mercato test:integration` booting a disposable
Postgres and app via testcontainers; Verdaccio in compose for preview publishes; and a
`platform-sync` script that pins the sandbox and dev deps to an OM release channel.

## Decision

Adopt that shape. Concretely: yarn 4 + turbo (pnpm is dropped for this repo — the OM tooling and
the sandbox assume yarn), the official `build.mjs` and export-map package template so our
packages are `module add`-able and ejectable exactly like official ones, `apps/sandbox`,
`__integration__` specs run by the OM ephemeral runner, the Verdaccio compose service, and
`platform:sync` with two channels (`latest`, and `develop` — what groomershop runs).

Not adopted: publishing npm canaries from CI, because the repo is private until `0.1.0`. In its
place, `scripts/install-lane.sh` packs both packages with `yarn pack` and installs the tarballs
into a fresh `create-mercato-app`, then runs the same Playwright specs. That proves the
*published* shape rather than the workspace link, which is the property the canary lane exists
to protect.

Two things this repo adds that official-modules does not have: `harness/`, a node-level
failure suite with no OM app in it (kills, stalls, replicas, lost leases), and a nightly soak.
Failure injection is deliberately not e2e's job.

The harness lives at the repo root rather than under `apps/` on purpose: the OM CLI resolves a
monorepo's app directory by taking the first non-dot, non-`docs` entry of `apps/` (unless
`apps/mercato` or `apps/app` exists), so a second directory there silently steals every
`mercato` command from the sandbox. `apps/` holds exactly one app.

## Consequences

- Anyone who has worked in `official-modules` can work here without relearning the layout, and
  upstream tooling changes are cheap to follow.
- The sandbox drifts from the template over time. `scripts/sync-sandbox.sh` regenerates it from
  `create-mercato-app@<channel>` preserving `.env`, migrations and our `example_sync` module,
  and the `compat` CI lane runs against `develop` so the channel our pilot uses is exercised.
- Tests are vitest here, not jest as in official-modules. No reason to follow that one.
