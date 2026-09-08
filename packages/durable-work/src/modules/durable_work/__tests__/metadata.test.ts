import { metadata } from '../index'
import { features } from '../acl'

describe('durable_work module metadata', () => {
  it('declares the module id the host registers', () => {
    expect(metadata.name).toBe('durable_work')
  })

  it('declares view and operate features scoped to the module', () => {
    expect(features.map((f) => f.id)).toEqual(['durable_work.view', 'durable_work.operate'])
    expect(features.every((f) => f.module === 'durable_work')).toBe(true)
  })
})
