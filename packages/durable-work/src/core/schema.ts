// The table. One statement list, used by the OM module's migration and by the harness, so
// what CI exercises and what a host migrates are the same DDL rather than two texts that
// drift. Re-homed from core's `progress_jobs` onto a package-owned table (ADR 0003); the
// column set and index set are the archived spec's §2, unchanged apart from the home.

export const TABLE = 'durable_work_jobs'

/** The zero uuid stands in for "no organization" in the single-runner index.
 *  Postgres treats NULLs as distinct in a unique index, so a null organization would let two
 *  tenant-wide jobs hold the same lock key. Coalescing is what makes the guarantee real, and
 *  it keeps PG14 support (PG15's NULLS NOT DISTINCT was the alternative). */
export const NO_ORG = '00000000-0000-0000-0000-000000000000'

export const CREATE_TABLE = `
create table if not exists ${TABLE} (
  id                      uuid primary key,
  tenant_id               uuid not null,
  organization_id         uuid null,
  kind                    text not null,
  status                  text not null,
  created_by              uuid null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  input                   jsonb null,
  checkpoint              jsonb null,
  meta                    jsonb null,

  idempotency_key         text null,
  lock_key                text null,
  subject_type            text null,
  subject_id              text null,
  progress_job_id         uuid null,

  lease_owner             text null,
  lease_epoch             bigint not null default 0,
  lease_expires_at        timestamptz null,
  heartbeat_at            timestamptz null,

  queue_name              text null,
  queue_job_id            text null,
  continuation_seq        int not null default 0,
  redrives                int not null default 0,
  next_run_at             timestamptz null,
  pending_since           timestamptz null,

  redrives_since_commit   int not null default 0,
  consecutive_failures    int not null default 0,
  interruptions           int not null default 0,
  mirror_attempts         int not null default 0,
  last_committed_at       timestamptz null,

  started_at              timestamptz null,
  finished_at             timestamptz null,
  parked_at               timestamptz null,
  cancel_requested_at     timestamptz null,
  cancelled_by            uuid null,
  error_class             text null,
  error_code              text null,
  error_message           text null,
  domain_mirrored_at      timestamptz null,

  processed_count         int not null default 0,
  total_count             int null
)`

/** fillfactor 80 leaves room for HOT updates. Heartbeats rewrite the row every few seconds for
 *  the length of a multi-day run, and a HOT update avoids touching any index — which is only
 *  true while no indexed column is written by the heartbeat statement. That is a real
 *  constraint on the statements below, not a hint: `heartbeat_at` is deliberately unindexed. */
export const SET_FILLFACTOR = `alter table ${TABLE} set (fillfactor = 80)`

export const CREATE_INDEXES: readonly string[] = [
  // Single-runner. At most one live job per (lock_key, tenant, org).
  `create unique index if not exists durable_work_jobs_one_live_per_lock_key
     on ${TABLE} (lock_key, tenant_id, coalesce(organization_id, '${NO_ORG}'::uuid))
   where lock_key is not null and status in ('pending','running')`,

  // Idempotency. Re-issuing the same key returns the existing job instead of starting a second.
  `create unique index if not exists durable_work_jobs_idempotency_uq
     on ${TABLE} (tenant_id, idempotency_key)
   where idempotency_key is not null`,

  // Reconciler scans. Each predicate deliberately excludes every column a heartbeat writes,
  // so a heartbeat never has to update an index (see fillfactor above).
  `create index if not exists durable_work_jobs_running_idx on ${TABLE} (tenant_id) where status = 'running'`,
  `create index if not exists durable_work_jobs_pending_idx on ${TABLE} (pending_since) where status = 'pending'`,
  `create index if not exists durable_work_jobs_cancelling_idx on ${TABLE} (cancel_requested_at)
   where cancel_requested_at is not null and status in ('pending','running')`,
  `create index if not exists durable_work_jobs_subject_idx on ${TABLE} (subject_type, subject_id) where subject_type is not null`,
  `create index if not exists durable_work_jobs_retention_idx on ${TABLE} (finished_at)
   where status in ('completed','failed','cancelled')`,
]

export const DROP_INDEXES: readonly string[] = [
  'drop index if exists durable_work_jobs_one_live_per_lock_key',
  'drop index if exists durable_work_jobs_idempotency_uq',
  'drop index if exists durable_work_jobs_running_idx',
  'drop index if exists durable_work_jobs_pending_idx',
  'drop index if exists durable_work_jobs_cancelling_idx',
  'drop index if exists durable_work_jobs_subject_idx',
  'drop index if exists durable_work_jobs_retention_idx',
]

export const DROP_TABLE = `drop table if exists ${TABLE}`

/** Every DDL statement in order. Idempotent: safe to run against a database that already has
 *  the table, which is what makes it usable from both the migration and a test's setup. */
export const SCHEMA_STATEMENTS: readonly string[] = [CREATE_TABLE, SET_FILLFACTOR, ...CREATE_INDEXES]

/** The index name Postgres reports on a single-runner violation. The store maps that specific
 *  violation to `LockKeyHeldError`; every other unique violation is a real bug and propagates. */
export const LOCK_KEY_INDEX = 'durable_work_jobs_one_live_per_lock_key'
export const IDEMPOTENCY_INDEX = 'durable_work_jobs_idempotency_uq'
