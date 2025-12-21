import { expect } from 'vitest'
import { unwrapSQLResult } from '../src/tools.ts'

describe('tools.unwrapSQLResult', function () {
  it('should return the same object when input is an object with rows', function () {
    const input = { rows: [{ id: 1 }, { id: 2 }] }
    const output = unwrapSQLResult(input)

    expect(output).toBe(input)
    expect(output).toEqual(input)
  })

  it('should flatten an array of results into a single rows array', function () {
    const part1 = { rows: [{ id: 'a' }] }
    const part2 = { rows: [{ id: 'b' }, { id: 'c' }] }
    const output = unwrapSQLResult([part1, part2])

    expect(output).toEqual({ rows: [part1.rows, part2.rows].flat() })
  })

  it('should handle empty array by returning empty rows', function () {
    const output = unwrapSQLResult([])
    expect(output).toEqual({ rows: [] })
  })
})
