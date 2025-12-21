import assert from 'node:assert'
import { unwrapSQLResult } from '../src/tools.ts'

describe('tools.unwrapSQLResult', function () {
  it('should return the same object when input is an object with rows', function () {
    const input = { rows: [{ id: 1 }, { id: 2 }] }
    const output = unwrapSQLResult(input)

    assert.strictEqual(output, input)
    assert.deepStrictEqual(output, input)
  })

  it('should flatten an array of results into a single rows array', function () {
    const part1 = { rows: [{ id: 'a' }] }
    const part2 = { rows: [{ id: 'b' }, { id: 'c' }] }
    const output = unwrapSQLResult([part1, part2])

    assert.deepStrictEqual(output, { rows: [part1.rows, part2.rows].flat() })
  })

  it('should handle empty array by returning empty rows', function () {
    const output = unwrapSQLResult([])
    assert.deepStrictEqual(output, { rows: [] })
  })
})
