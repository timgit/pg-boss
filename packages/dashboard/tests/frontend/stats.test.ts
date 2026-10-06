import { describe, it, expect } from 'vitest'
import { niceMax } from '~/lib/stats'

describe('niceMax', () => {
  it('rounds up to four steps of 1, 2 or 5 × 10ⁿ', () => {
    expect(niceMax(3.7)).toBe(4)
    expect(niceMax(130)).toBe(200)
    expect(niceMax(0.32)).toBe(0.4)
    expect(niceMax(1900)).toBe(2000)
    expect(niceMax(4100)).toBe(8000)
  })

  it('gives an axis to a series with nothing on it', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(null)).toBe(1)
    expect(niceMax(Number.NaN)).toBe(1)
  })
})
