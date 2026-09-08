// The MikroORM view of the job table.
//
// The mechanism itself never goes through this entity — every statement in `core/store.ts` is
// hand-written SQL, because each is a compare-and-set whose predicate is the guarantee. The
// entity exists so the table is discoverable to the host: migrations, the entity registry,
// query tooling and anything an app wants to join against.
//
// It must therefore stay in step with `core/schema.ts`, which is the definition. A test
// asserts they agree column for column.

import { OptionalProps } from '@mikro-orm/core'
import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy'

export type DurableWorkJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

@Entity({ tableName: 'durable_work_jobs' })
@Index({ name: 'durable_work_jobs_running_idx', properties: ['tenantId'] })
@Index({ name: 'durable_work_jobs_subject_idx', properties: ['subjectType', 'subjectId'] })
export class DurableWorkJob {
  [OptionalProps]?:
    | 'status'
    | 'leaseEpoch'
    | 'continuationSeq'
    | 'redrives'
    | 'redrivesSinceCommit'
    | 'consecutiveFailures'
    | 'interruptions'
    | 'mirrorAttempts'
    | 'processedCount'
    | 'createdAt'
    | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'kind', type: 'text' })
  kind!: string

  @Property({ name: 'status', type: 'text' })
  status: DurableWorkJobStatus = 'pending'

  @Property({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null

  @Property({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: 'timestamptz', onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'input', type: 'jsonb', nullable: true })
  input?: unknown

  @Property({ name: 'checkpoint', type: 'jsonb', nullable: true })
  checkpoint?: unknown

  @Property({ name: 'meta', type: 'jsonb', nullable: true })
  meta?: Record<string, unknown> | null

  @Property({ name: 'idempotency_key', type: 'text', nullable: true })
  idempotencyKey?: string | null

  @Property({ name: 'lock_key', type: 'text', nullable: true })
  lockKey?: string | null

  @Property({ name: 'subject_type', type: 'text', nullable: true })
  subjectType?: string | null

  @Property({ name: 'subject_id', type: 'text', nullable: true })
  subjectId?: string | null

  @Property({ name: 'progress_job_id', type: 'uuid', nullable: true })
  progressJobId?: string | null

  @Property({ name: 'lease_owner', type: 'text', nullable: true })
  leaseOwner?: string | null

  @Property({ name: 'lease_epoch', type: 'bigint' })
  leaseEpoch: number = 0

  @Property({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt?: Date | null

  @Property({ name: 'heartbeat_at', type: 'timestamptz', nullable: true })
  heartbeatAt?: Date | null

  @Property({ name: 'queue_name', type: 'text', nullable: true })
  queueName?: string | null

  @Property({ name: 'queue_job_id', type: 'text', nullable: true })
  queueJobId?: string | null

  @Property({ name: 'continuation_seq', type: 'int' })
  continuationSeq: number = 0

  @Property({ name: 'redrives', type: 'int' })
  redrives: number = 0

  @Property({ name: 'next_run_at', type: 'timestamptz', nullable: true })
  nextRunAt?: Date | null

  @Property({ name: 'pending_since', type: 'timestamptz', nullable: true })
  pendingSince?: Date | null

  @Property({ name: 'redrives_since_commit', type: 'int' })
  redrivesSinceCommit: number = 0

  @Property({ name: 'consecutive_failures', type: 'int' })
  consecutiveFailures: number = 0

  @Property({ name: 'interruptions', type: 'int' })
  interruptions: number = 0

  @Property({ name: 'mirror_attempts', type: 'int' })
  mirrorAttempts: number = 0

  @Property({ name: 'last_committed_at', type: 'timestamptz', nullable: true })
  lastCommittedAt?: Date | null

  @Property({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt?: Date | null

  @Property({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt?: Date | null

  @Property({ name: 'parked_at', type: 'timestamptz', nullable: true })
  parkedAt?: Date | null

  @Property({ name: 'cancel_requested_at', type: 'timestamptz', nullable: true })
  cancelRequestedAt?: Date | null

  @Property({ name: 'cancelled_by', type: 'uuid', nullable: true })
  cancelledBy?: string | null

  @Property({ name: 'error_class', type: 'text', nullable: true })
  errorClass?: string | null

  @Property({ name: 'error_code', type: 'text', nullable: true })
  errorCode?: string | null

  @Property({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string | null

  @Property({ name: 'domain_mirrored_at', type: 'timestamptz', nullable: true })
  domainMirroredAt?: Date | null

  @Property({ name: 'processed_count', type: 'int' })
  processedCount: number = 0

  @Property({ name: 'total_count', type: 'int', nullable: true })
  totalCount?: number | null
}
