# Architecture decision records

One file per decision that shapes the packages. Format: context, decision, consequences.
An ADR is amended (not deleted) when it turns out wrong; the roadmap's MVP line names the
things that need a *new* ADR before they can come in.

| # | Decision |
|---|---|
| [0001](0001-transport-adapters.md) | Package-owned transport adapter with three implementations (memory, BullMQ, pg-boss) |
| [0002](0002-record-authority.md) | `durable_work_jobs` is the authority for liveness; domain rows keep domain state |
| [0003](0003-re-home-from-progress-jobs.md) | The leased tier lives in a package-owned table, not in core's `progress_jobs` |
| [0004](0004-fork-slice-engine.md) | Fork `data_sync`'s batch loop into a slice engine, guarded by a hash probe |
| [0005](0005-repo-shape-official-modules.md) | Mirror `open-mercato/official-modules`' repo shape |
| [0006](0006-drop-in-data-sync.md) | `data-sync-durable` is a drop-in for core's `data_sync`, not an overrides add-on |
