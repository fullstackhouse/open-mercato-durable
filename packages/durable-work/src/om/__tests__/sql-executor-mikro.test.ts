import { toPositional } from '../sql-executor-mikro'

// The statements are written in Postgres's own `$n` form so the SQL the failure harness
// exercises is character-for-character the SQL a host runs. MikroORM binds `?` positionally,
// and this is the whole of the translation between them — so it is the whole of what can go
// silently wrong between a tested statement and a deployed one.
describe('toPositional', () => {
  it('rewrites placeholders in order', () => {
    expect(toPositional('select $1, $2', ['a', 'b'])).toEqual({ text: 'select ?, ?', params: ['a', 'b'] })
  })

  it('duplicates a parameter that the statement reads twice', () => {
    // The scope predicate does exactly this: compares the organization and tests it for null.
    const sql = 'where organization_id = $2 or ($2::uuid is null and organization_id is null)'
    expect(toPositional(sql, ['tenant', null])).toEqual({
      text: 'where organization_id = ? or (?::uuid is null and organization_id is null)',
      params: [null, null],
    })
  })

  it('handles placeholders that are not in ascending order', () => {
    expect(toPositional('select $3, $1', ['a', 'b', 'c'])).toEqual({ text: 'select ?, ?', params: ['c', 'a'] })
  })

  it('refuses a statement that references a parameter nobody supplied', () => {
    // Silently binding undefined would turn a fenced predicate into one that matches nothing,
    // which reads exactly like "the lease was lost" and would be debugged as such.
    expect(() => toPositional('select $2', ['only-one'])).toThrow(/references \$2 but 1 parameter/)
  })
})
