import { describe, expect, it } from 'vitest'
import { checkBinds, IGNORE_MARKER, kindOf } from './bindAuditRules.ts'

// The bind audit only fails a run when a rule fires, so a rule that never fires would pass every
// run. These pin each rule to the case it exists for, and to the case it must leave alone.
describe('bind audit rules', function () {
  const rules = (text: string, types: string[], values: unknown[]) =>
    checkBinds(text, types, values.map(kindOf)).map(finding => finding.rule)

  it('flags a string bound to a json parameter, and not one routed through text', function () {
    expect(rules('INSERT INTO t (data) VALUES ($1)', ['jsonb'], ['{}'])).toEqual(['string-to-json'])
    expect(rules('SELECT json_to_recordset($1::json)', ['json'], ['[]'])).toEqual(['string-to-json'])
    expect(rules('INSERT INTO t (data) VALUES ($1::text::jsonb)', ['text'], ['{}'])).toEqual([])
  })

  it('flags an array bound to a json parameter, and not an object', function () {
    expect(rules('INSERT INTO t (data) VALUES ($1)', ['jsonb'], [[1, 2]])).toEqual(['array-to-json'])
    expect(rules('INSERT INTO t (data) VALUES ($1)', ['jsonb'], [{ a: 1 }])).toEqual([])
  })

  it('flags an object bound to a parameter that is not json', function () {
    expect(rules('SELECT $1::text', ['text'], [{ a: 1 }])).toEqual(['object-to-non-json'])
    expect(rules('SELECT $1::timestamptz', ['timestamp with time zone'], [new Date()])).toEqual([])
  })

  it('flags an array parameter unless every occurrence carries an array cast', function () {
    expect(rules('SELECT 1 WHERE id = ANY($1::uuid[])', ['uuid[]'], [['a']])).toEqual([])
    expect(rules('SELECT 1 WHERE id = ANY($1)', ['uuid[]'], [['a']])).toEqual(['array-not-expanded'])
    expect(rules('SELECT 1 WHERE id = ANY($1::uuid[]) OR key = ANY($1)', ['uuid[]'], [['a']])).toEqual(['array-not-expanded'])
  })

  it('leaves null and scalar binds alone', function () {
    expect(rules('INSERT INTO t (data, n) VALUES ($1, $2)', ['jsonb', 'integer'], [null, 3])).toEqual([])
  })

  it('skips a statement carrying the ignore marker', function () {
    expect(rules(`${IGNORE_MARKER} INSERT INTO t (data) VALUES ($1)`, ['jsonb'], ['{}'])).toEqual([])
  })

  it('reports the parameter number and inferred type', function () {
    const [finding] = checkBinds('INSERT INTO t (a, data) VALUES ($1, $2)', ['text', 'jsonb'], ['string', 'string'])
    expect(finding).toMatchObject({ rule: 'string-to-json', param: 2, type: 'jsonb', kind: 'string' })
  })
})
