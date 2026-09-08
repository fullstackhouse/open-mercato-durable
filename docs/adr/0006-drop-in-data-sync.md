# 0006 — `data-sync-durable` is a drop-in for core's `data_sync`, not an add-on

Status: accepted (2026-09-07)

## Context

The first design for the adopter was an *add-on* module: a separate module id that registers
DI replacements and `overrides.routes.api` entries against core's still-loaded `data_sync`.
It works, but every host has to understand and maintain the override wiring, the host's
`ModuleEntry` type has to be widened to accept `overrides`, and swapping back is a diff rather
than a line.

Checking the OM CLI's generator settled it: any `from` package resolves to
`<pkg>/dist/modules/<id>`, the only validation for third-party scopes is that the subtree
exists, and there is no reserved-id list. A package may legitimately supply `id: 'data_sync'`.
Migrations are collected per enabled module from the resolved package into
`mikro_orm_migrations_<id>`, so a swapped package that ships core's migration classes under the
same names leaves an existing history untouched.

## Decision

Ship `dist/modules/data_sync/` from our package and let the host swap the source:

```ts
{ id: 'data_sync', from: '@fullstackhouse/open-mercato-data-sync-durable' },  // was '@open-mercato/core'
```

Same module id, tables, REST API, adapter contract, events, ACL, UI and CLI. Roughly ten files
are genuinely ours (`di.ts`, `lib/start-run.ts`, the run and retry routes, the three workers,
`cli.ts`, a version guard and a progress sweep worker); every other file is a **generated
re-export stub** to core's deep path, produced by `scripts/gen-mirror.mjs` against the pinned
core and recorded in `mirror.manifest.json`. i18n JSON is copied; migration classes are
re-exported under identical names.

Release policy: one package line per core minor (`0.7.x` ↔ `data-sync-durable 0.7.*`), peer
`@open-mercato/core >=0.7.0 <0.8.0`, and a boot check that fails loudly when the installed core
minor differs from the mirrored one. Hosts that have ejected `data_sync` into `@app` are out of
scope.

## Consequences

- The whole host change is one line, and reverting is the same line. Adapters (`subiekt_sync`,
  `sync_excel`, `sync_akeneo`) are untouched: they import core's deep paths, which our stubs
  re-export, so there is still one process-wide adapter registry and one entity class.
- We own the appearance of core's entire `data_sync` surface — 52 files — even though we only
  wrote ten of them. `gen:mirror --check` and the manifest hashes are what keep that from
  rotting silently.
- Hosts must bump both packages together. The version guard says so at boot rather than failing
  strangely at runtime.

## Spike result (phase 0, core 0.7.0)

The open question was whether the OM generator's *static* readers follow a package re-export.
Measured by generating the sandbox twice — once with `data_sync` from core, once from this
package — and diffing every generated artifact with the package specifier normalised away.

Pure `export * from …` stubs are enough for: module metadata, ACL, events, setup, DI, i18n
JSON, entity registration, backend pages and their `page.meta`, and workers. Three things they
are **not** enough for, each now handled by `gen-mirror`:

1. **API routes registered zero methods.** `detectExportedHttpMethods` is a regex over the
   file's own text; a star export is invisible to it. The stub now names the methods
   explicitly (`export { GET, POST } from …`), a shape that function already understands.
2. **Route `metadata` came out `undefined`** on the runtime route table — i.e. every route
   silently lost its `requireAuth` / `requireFeatures`. It is read by AST
   (`extractNamedObjectLiteralExport`), with a dynamic-import fallback that cannot load a
   source file from `node_modules`. Core hits the same fallback and survives on the AST read,
   so the literal is now **copied verbatim** into the stub. `openApi` only needs to be seen to
   exist, so an alias re-export suffices there.
3. **`E.data_sync` came out empty** — entity ids and the field registry are parsed from
   `@Entity()` class declarations, which a stub has none of. `data/entities.ts` deliberately
   stays a star stub: the app's `entities.generated.ts` spreads our namespace, so MikroORM
   registers **core's actual classes** and identity is preserved for every core service that
   queries them. Copying the classes would have registered duplicates. Instead the package
   ships the `generated/` descriptor (`entities.ids.generated.ts` plus
   `generated/entities/<name>/index.ts`) that the CLI already looks for on a package-backed
   module, produced by `gen-mirror` from core's real entities file with the CLI's own rules.

With those three, the sandbox's generated output is **identical to core's** for every artifact
except `module-package-sources.css`, which correctly gains one `@source` line for this
package's Tailwind sources. The stub style stands; no literal-copy fallback for the bulk.
