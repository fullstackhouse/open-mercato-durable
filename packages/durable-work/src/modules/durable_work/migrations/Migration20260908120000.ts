import { Migration } from '@mikro-orm/migrations'

import { CREATE_INDEXES, CREATE_TABLE, DROP_INDEXES, DROP_TABLE, SET_FILLFACTOR } from '../../../core/schema'

/**
 * Creates `durable_work_jobs`.
 *
 * The statements come from `core/schema.ts` rather than being written out again here, so what
 * a host migrates and what the failure harness exercises are the same DDL. Two copies of a
 * schema drift, and the way that drift surfaces is a predicate silently not being enforced in
 * production while every test still passes.
 */
export class Migration20260908120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(CREATE_TABLE)
    this.addSql(SET_FILLFACTOR)
    for (const statement of CREATE_INDEXES) this.addSql(statement)
  }

  override async down(): Promise<void> {
    for (const statement of DROP_INDEXES) this.addSql(statement)
    this.addSql(DROP_TABLE)
  }
}
