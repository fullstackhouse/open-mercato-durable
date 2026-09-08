// `core/schema.ts` is the definition of the table; the MikroORM entity is a second description
// of the same thing, for the host's benefit. Two descriptions drift, and the way this
// particular drift would surface is ugly: the host's migration creates one shape while the
// statements — every one of them a compare-and-set naming columns explicitly — expect another,
// so the failure lands at runtime on a predicate rather than at migration time on a schema.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CREATE_TABLE } from '../../../core/schema'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Column names as they appear in the DDL. */
function ddlColumns(): string[] {
  const body = CREATE_TABLE.slice(CREATE_TABLE.indexOf('(') + 1, CREATE_TABLE.lastIndexOf(')'))
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/)[0]!)
    .filter((name) => /^[a-z_]+$/.test(name))
    .sort()
}

/** Column names the entity declares, read from the source rather than from decorator metadata:
 *  loading metadata would need a configured ORM, and this only has to compare two lists. */
function entityColumns(): string[] {
  const source = fs.readFileSync(path.join(HERE, '..', 'data', 'entities.ts'), 'utf8')
  const names = [...source.matchAll(/@(?:Property|PrimaryKey)\(\{[^}]*name:\s*'([a-z_]+)'/g)].map((m) => m[1]!)
  // The primary key declares no `name`, so it is added explicitly.
  return [...new Set([...names, 'id'])].sort()
}

describe('durable_work_jobs schema', () => {
  it('declares the same columns in the DDL and in the entity', () => {
    const ddl = ddlColumns()
    const entity = entityColumns()
    expect(ddl.length).toBeGreaterThan(30)
    expect(entity).toEqual(ddl)
  })

  it('keeps the columns the fence depends on', () => {
    // Named individually because losing any one of them silently removes a guarantee rather
    // than breaking a build: no epoch is no fence, no lock key is no single-runner, no
    // idempotency key turns a retried start into a second job.
    for (const column of ['lease_epoch', 'lease_owner', 'lease_expires_at', 'lock_key', 'idempotency_key', 'continuation_seq', 'redrives']) {
      expect(ddlColumns()).toContain(column)
    }
  })
})
