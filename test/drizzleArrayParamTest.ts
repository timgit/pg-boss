import { describe, it, expect } from 'vitest'
import { fromDrizzle, type DrizzleSqlTagLike } from '../src/adapters/drizzle.ts'

// pg-boss binds job ids and queue names as JS arrays against `= ANY($N::uuid[])`. node-postgres and
// postgres-js encode those natively; Bun's SQL client cannot, and stringifies the array to a bare
// comma-joined list, so every completion path fails with `malformed array literal`
// (oven-sh/bun#18775, still open on 1.3.9 - its sql.array() helper is opt-in and driver-specific).
//
// The adapter therefore expands an array into an inline ARRAY[...] of scalar parameters. These
// tests pin that expansion at the point where the driver would see it: no bind value is ever an
// array, and no value is ever escaped into SQL text.
//
// No Bun in CI: the last test models the stringifying driver with a fake encoder.

// A stand-in for drizzle's sql tag: it records what the adapter assembled instead of building a
// query, so the assertions can read the final SQL text and the bind values separately.
function captureSql () {
  const captured: { text: string, params: unknown[] } = { text: '', params: [] }

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.params = values.map(value => (value as { value: unknown }).value)
    captured.text = strings.reduce(
      (text, part, index) => text + (index === 0 ? '' : `$${index}`) + part,
      ''
    )
    return captured
  }) as DrizzleSqlTagLike

  sql.param = (value: unknown) => ({ value })

  return { sql, captured }
}

async function assemble (text: string, values?: unknown[]) {
  const { sql, captured } = captureSql()
  const tx = { execute: async () => ({ rows: [] }) }
  await fromDrizzle(tx, sql).executeSql(text, values)
  return captured
}

describe('drizzle adapter array parameters', () => {
  it('expands a multi-element array into an ARRAY constructor of scalar parameters', async () => {
    const captured = await assemble('WHERE name = $1 AND id = ANY($2::uuid[])', ['q', ['a', 'b']])

    expect(captured.text).toBe('WHERE name = $1 AND id = ANY(ARRAY[$2,$3]::uuid[])')
    expect(captured.params).toEqual(['q', 'a', 'b'])
  })

  it('expands a single-element array', async () => {
    const captured = await assemble('id = ANY($1::uuid[])', [['a']])

    expect(captured.text).toBe('id = ANY(ARRAY[$1]::uuid[])')
    expect(captured.params).toEqual(['a'])
  })

  it('expands an empty array to an empty constructor the cast resolves', async () => {
    const captured = await assemble('id = ANY($1::uuid[])', [[]])

    expect(captured.text).toBe('id = ANY(ARRAY[]::uuid[])')
    expect(captured.params).toEqual([])
  })

  it('leaves scalar parameters bound one placeholder each', async () => {
    const captured = await assemble('SELECT $1, $2, $3', ['a', 1, null])

    expect(captured.text).toBe('SELECT $1, $2, $3')
    expect(captured.params).toEqual(['a', 1, null])
  })

  it('expands each occurrence of a repeated array placeholder', async () => {
    const captured = await assemble('$1::uuid[] AND $1::uuid[]', [['a', 'b']])

    expect(captured.text).toBe('ARRAY[$1,$2]::uuid[] AND ARRAY[$3,$4]::uuid[]')
    expect(captured.params).toEqual(['a', 'b', 'a', 'b'])
  })

  it('keeps arrays out of the SQL text when elements contain quotes, commas and braces', async () => {
    const names = ["it's", 'a,b', '{x}', 'back\\slash']
    const captured = await assemble('name = ANY($1::text[])', [names])

    expect(captured.text).toBe('name = ANY(ARRAY[$1,$2,$3,$4]::text[])')
    expect(captured.params).toEqual(names)
  })

  it('leaves a JSON array bound whole', async () => {
    // an array cast to json is a JSON array, not a postgres array: expanding it would store
    // something else
    const captured = await assemble('SELECT $1::jsonb, $2', [[1, 2], [3]])

    expect(captured.text).toBe('SELECT $1::jsonb, $2')
    expect(captured.params).toEqual([[1, 2], [3]])
  })

  it('never hands an array to a driver that would stringify it', async () => {
    // Bun's encoder, in the shape that produces `malformed array literal`: an array reaches the
    // wire as a bare comma-joined list, with none of the braces an array literal needs.
    const encode = (value: unknown) => Array.isArray(value) ? String(value) : value

    expect(encode(['a', 'b'])).toBe('a,b')

    const captured = await assemble('id = ANY($1::uuid[])', [['a', 'b']])

    expect(captured.params.some(Array.isArray)).toBe(false)
    expect(captured.params.map(encode)).toEqual(['a', 'b'])
  })
})
