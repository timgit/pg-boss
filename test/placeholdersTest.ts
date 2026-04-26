import { describe, it, expect } from 'vitest'
import { parsePlaceholders } from '../src/adapters/placeholders.ts'

describe('parsePlaceholders', () => {
  it('returns the whole string when there are no placeholders', () => {
    const { parts, reordered } = parsePlaceholders('SELECT 1', [])
    expect(parts).toEqual(['SELECT 1'])
    expect(reordered).toEqual([])
  })

  it('handles missing values argument', () => {
    const { parts, reordered } = parsePlaceholders('SELECT 1')
    expect(parts).toEqual(['SELECT 1'])
    expect(reordered).toEqual([])
  })

  it('handles sequential placeholders', () => {
    const { parts, reordered } = parsePlaceholders('SELECT $1, $2', ['a', 'b'])
    expect(parts).toEqual(['SELECT ', ', ', ''])
    expect(reordered).toEqual(['a', 'b'])
  })

  it('duplicates values for repeated placeholders', () => {
    const { parts, reordered } = parsePlaceholders(
      'WHERE ($1::text IS NULL OR type = $1)',
      ['warn']
    )
    expect(parts).toEqual(['WHERE (', '::text IS NULL OR type = ', ')'])
    expect(reordered).toEqual(['warn', 'warn'])
  })

  it('handles out-of-order placeholders', () => {
    const { parts, reordered } = parsePlaceholders(
      'SELECT $2, $1, $2',
      [10, 20]
    )
    expect(parts).toEqual(['SELECT ', ', ', ', ', ''])
    expect(reordered).toEqual([20, 10, 20])
  })

  it('parses multi-digit indexes', () => {
    const values = Array.from({ length: 12 }, (_, i) => i + 1)
    const { reordered } = parsePlaceholders('SELECT $10, $11, $12, $1', values)
    expect(reordered).toEqual([10, 11, 12, 1])
  })

  it('yields undefined when an index has no matching value', () => {
    const { reordered } = parsePlaceholders('SELECT $1, $2', ['a'])
    expect(reordered).toEqual(['a', undefined])
  })

  it('leaves a stray $ untouched when not followed by a digit', () => {
    const { parts, reordered } = parsePlaceholders("SELECT 'price: $USD' as label, $1", ['x'])
    expect(parts).toEqual(["SELECT 'price: $USD' as label, ", ''])
    expect(reordered).toEqual(['x'])
  })

  it('treats $ at end of string as a literal', () => {
    const { parts, reordered } = parsePlaceholders('SELECT $', [])
    expect(parts).toEqual(['SELECT $'])
    expect(reordered).toEqual([])
  })
})
