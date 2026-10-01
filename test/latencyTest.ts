import { expect } from 'vitest'
import { addBins, percentile } from '../src/index.ts'
import { LATENCY_SLOTS } from '../src/plans.ts'

/** A histogram with these counts in these slots and zeros everywhere else. */
function bins (counts: Record<number, number>): number[] {
  const all = new Array(LATENCY_SLOTS).fill(0)
  for (const [slot, n] of Object.entries(counts)) all[Number(slot)] = n
  return all
}

/** The lower edge of slot k, in seconds. */
const edge = (k: number) => 0.01 * Math.SQRT2 ** (k - 1)

/** The slot the monitor puts a duration in: ln(t / 10 ms) over ln(√2), plus one, clamped. */
const slotOf = (seconds: number) =>
  Math.min(Math.max(Math.floor(Math.log(Math.max(seconds, 0.001) / 0.01) / (Math.log(2) / 2)) + 1, 0), LATENCY_SLOTS - 1)

/** The histogram the monitor would record for these durations. */
function binsOf (durations: number[]): number[] {
  const all = new Array(LATENCY_SLOTS).fill(0)
  for (const d of durations) all[slotOf(d)]++
  return all
}

/** The exact percentile of raw durations: the smallest one with at least a fraction p at or below it. */
function exact (durations: number[], p: number): number {
  const sorted = [...durations].sort((a, b) => a - b)
  return sorted[Math.max(Math.ceil(p * sorted.length) - 1, 0)]
}

/** A seeded generator (mulberry32), so every run draws the same durations. */
function seeded (seed: number): () => number {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = seeded(42)
const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())

/** Duration distributions in seconds, from smooth to the shapes that are hardest to bin. */
const DISTRIBUTIONS: Record<string, () => number> = {
  lognormal: () => Math.exp(Math.log(0.5) + 1.2 * normal()),
  uniform: () => 0.05 + 5 * random(),
  pareto: () => 0.1 / Math.pow(1 - random(), 1 / 1.5),
  bimodal: () => (random() < 0.8 ? 0.02 : 30) * Math.exp(0.2 * normal()),
  constant: () => 2.5
}

describe('latency histograms', function () {
  it('reads a percentile within its slot, on the log scale', function () {
    // 100 jobs, all in slot 10: the median is halfway through the slot on the log scale
    const p50 = percentile(bins({ 10: 100 }), 50)!
    expect(p50).toBeCloseTo(edge(10) * Math.SQRT2 ** 0.5, 10)
    expect(p50).toBeGreaterThan(edge(10))
    expect(p50).toBeLessThan(edge(11))
  })

  it('finds the slot the percentile falls in', function () {
    const h = bins({ 5: 90, 20: 10 })
    expect(percentile(h, 90)).toBeLessThanOrEqual(edge(6))
    expect(percentile(h, 95)).toBeGreaterThan(edge(20))
    expect(percentile(h, 95)).toBeLessThan(edge(21))
  })

  it('answers 10 ms for a percentile under 10 ms, and the last slot\'s lower edge past it', function () {
    expect(percentile(bins({ 0: 5 }), 50)).toBe(0.01)
    expect(percentile(bins({ [LATENCY_SLOTS - 1]: 5 }), 99)).toBe(edge(LATENCY_SLOTS - 1))
  })

  it('skips empty slots, so a low percentile falls in the first slot used', function () {
    const p1 = percentile(bins({ 12: 3 }), 1)!
    expect(p1).toBeGreaterThan(edge(12))
    expect(p1).toBeLessThan(edge(13))
  })

  it('returns null for an empty or missing histogram', function () {
    expect(percentile(bins({}), 95)).toBe(null)
    expect(percentile(null, 95)).toBe(null)
    expect(percentile(undefined, 95)).toBe(null)
  })

  it('refuses a p outside 1 to 100, including a fraction meant as one', function () {
    for (const p of [0.95, 0, 101, -5]) {
      expect(() => percentile(bins({ 3: 1 }), p), String(p)).toThrow('percent from 1 to 100')
    }
  })

  it('reads across slots the way Prometheus reads a native histogram', function () {
    // half the jobs in slot 10, half in slot 11: p75 is halfway through slot 11 on the log scale
    expect(percentile(bins({ 10: 50, 11: 50 }), 75)).toBeCloseTo(edge(11) * Math.SQRT2 ** 0.5, 10)
  })

  it('lands within a factor of √2 of the exact percentile, whatever the distribution', function () {
    for (const [name, draw] of Object.entries(DISTRIBUTIONS)) {
      for (const n of [200, 20_000]) {
        const durations = Array.from({ length: n }, draw)
        const histogram = binsOf(durations)
        for (const p of [50, 90, 95, 99]) {
          const ratio = percentile(histogram, p)! / exact(durations, p / 100)
          expect(ratio, `${name}, ${n} jobs, p${p}`).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-9)
          expect(ratio, `${name}, ${n} jobs, p${p}`).toBeLessThanOrEqual(Math.SQRT2 + 1e-9)
        }
      }
    }
  })

  it('is within 5% of the exact percentile for many jobs from a smooth distribution', function () {
    for (const name of ['lognormal', 'uniform', 'pareto']) {
      const durations = Array.from({ length: 20_000 }, DISTRIBUTIONS[name])
      const histogram = binsOf(durations)
      for (const p of [50, 90, 95]) {
        const error = Math.abs(percentile(histogram, p)! / exact(durations, p / 100) - 1)
        expect(error, `${name}, p${p}`).toBeLessThan(0.05)
      }
    }
  })

  it('reads the same percentile from added histograms as from all the jobs binned together', function () {
    const a = Array.from({ length: 3000 }, DISTRIBUTIONS.lognormal)
    const b = Array.from({ length: 500 }, DISTRIBUTIONS.bimodal)
    for (const p of [50, 95, 99]) {
      expect(percentile(addBins(binsOf(a), binsOf(b)), p)).toBe(percentile(binsOf([...a, ...b]), p))
    }
  })

  it('adds histograms slot by slot, treating a missing one as nothing', function () {
    expect(addBins(bins({ 3: 1, 4: 2 }), bins({ 4: 5, 9: 1 }))).toEqual(bins({ 3: 1, 4: 7, 9: 1 }))
    expect(addBins(null, bins({ 2: 1 }))).toEqual(bins({ 2: 1 }))
    expect(addBins(bins({ 2: 1 }), undefined)).toEqual(bins({ 2: 1 }))
    expect(addBins(null, null)).toBe(null)
  })

  it('does not change the histograms it adds', function () {
    const a = bins({ 1: 1 })
    const sum = addBins(a, bins({ 1: 1 }))!
    sum[1] = 99
    expect(a[1]).toBe(1)
  })
})
