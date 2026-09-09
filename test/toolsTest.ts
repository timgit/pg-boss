import { expect } from 'vitest'
import { clockDelay, resolveWithinSeconds, unwrapSQLResult } from '../src/tools.ts'
import type { Clock, ClockTimer } from '../src/types.ts'

// Fires nothing until told to; the test is the only source of time.
class ManualClock implements Clock {
  time = 0
  timers = new Map<number, { fn: () => void, due: number }>()
  private seq = 0

  now () { return this.time }

  setTimeout (fn: () => void, ms: number) {
    const handle = ++this.seq
    this.timers.set(handle, { fn, due: this.time + ms })
    return handle
  }

  clearTimeout (handle: ClockTimer) { this.timers.delete(handle as number) }
  setInterval (fn: () => void, ms: number) { return this.setTimeout(fn, ms) }
  clearInterval (handle: ClockTimer) { this.clearTimeout(handle) }

  advance (ms: number) {
    this.time += ms
    for (const [handle, timer] of [...this.timers]) {
      if (timer.due <= this.time) {
        this.timers.delete(handle)
        timer.fn()
      }
    }
  }
}

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

describe('tools.clockDelay', function () {
  it('resolves only when the clock reaches the delay', async function () {
    const clock = new ManualClock()
    let settled = false
    const promise = clockDelay(clock, 1000).then(() => { settled = true })

    clock.advance(999)
    await Promise.resolve()
    expect(settled).toBe(false)

    clock.advance(1)
    await promise
    expect(settled).toBe(true)
  })

  it('rejects with the message when one is given', async function () {
    const clock = new ManualClock()
    const promise = clockDelay(clock, 10, 'too slow')
    clock.advance(10)
    await expect(promise).rejects.toThrow('too slow')
  })

  it('abort resolves early and releases the timer', async function () {
    const clock = new ManualClock()
    const promise = clockDelay(clock, 10, 'too slow')
    promise.abort()
    await promise
    expect(clock.timers.size).toBe(0)
  })
})

describe('tools.resolveWithinSeconds', function () {
  it('returns the value and clears the timer when the promise settles first', async function () {
    const clock = new ManualClock()
    const result = await resolveWithinSeconds(clock, Promise.resolve(42), 5, 'late')
    expect(result).toBe(42)
    expect(clock.timers.size).toBe(0)
  })

  it('rejects when the clock passes the deadline first', async function () {
    const clock = new ManualClock()
    const pending = new Promise<never>(() => {})
    const race = resolveWithinSeconds(clock, pending, 5, 'handler execution exceeded 5s')
    clock.advance(5000)
    await expect(race).rejects.toThrow('handler execution exceeded 5s')
  })
})
