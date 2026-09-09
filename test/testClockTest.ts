import { expect } from 'vitest'
import { TestClock } from '../src/clock.ts'
import { clockDelay } from '../src/tools.ts'

const T0 = Date.parse('2026-01-01T00:00:00Z')

describe('TestClock (pure)', function () {
  it('starts at the given time and does not move on its own', async function () {
    const clock = new TestClock(T0)
    expect(clock.now()).toBe(T0)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(clock.now()).toBe(T0)
  })

  it('fires timers in due order, then insertion order for equal due times', async function () {
    const clock = new TestClock(T0)
    const fired: string[] = []

    clock.setTimeout(() => fired.push('b@20'), 20)
    clock.setTimeout(() => fired.push('a@10'), 10)
    clock.setTimeout(() => fired.push('c@20'), 20)
    clock.setTimeout(() => fired.push('d@30'), 30)

    await clock.tick(20)

    expect(fired).toEqual(['a@10', 'b@20', 'c@20'])
    expect(clock.now()).toBe(T0 + 20)
  })

  it('sets now to each timer due time as it fires', async function () {
    const clock = new TestClock(T0)
    const seen: number[] = []

    clock.setTimeout(() => seen.push(clock.now() - T0), 10)
    clock.setTimeout(() => seen.push(clock.now() - T0), 25)

    await clock.tick(100)

    expect(seen).toEqual([10, 25])
    expect(clock.now()).toBe(T0 + 100)
  })

  it('reschedules an interval after each firing', async function () {
    const clock = new TestClock(T0)
    let count = 0
    const handle = clock.setInterval(() => count++, 10)

    await clock.tick(35)
    expect(count).toBe(3)

    clock.clearInterval(handle)
    await clock.tick(100)
    expect(count).toBe(3)
  })

  it('a timer cleared from inside a callback does not fire', async function () {
    const clock = new TestClock(T0)
    const fired: string[] = []
    const second = { handle: undefined as unknown }

    clock.setTimeout(() => {
      fired.push('first')
      clock.clearTimeout(second.handle)
    }, 10)
    second.handle = clock.setTimeout(() => fired.push('second'), 10)

    await clock.tick(10)
    expect(fired).toEqual(['first'])
  })

  it('a timer scheduled from inside a callback fires within the same tick when due', async function () {
    const clock = new TestClock(T0)
    const fired: string[] = []

    clock.setTimeout(() => {
      fired.push('outer')
      clock.setTimeout(() => fired.push('inner'), 5)
    }, 10)

    await clock.tick(15)
    expect(fired).toEqual(['outer', 'inner'])
  })

  it('rejects a tick while another is in progress', async function () {
    const clock = new TestClock(T0)
    let nested: Promise<unknown> | undefined

    clock.setTimeout(() => { nested = clock.tick(1).catch(err => err) }, 1)
    await clock.tick(1)

    expect(await nested).toMatchObject({ message: 'TestClock: tick() called while a tick is in progress' })
  })

  it('setTime jumps without firing, in either direction', async function () {
    const clock = new TestClock(T0)
    let fired = 0
    clock.setTimeout(() => fired++, 10)

    await clock.setTime(T0 + 1000)
    expect(fired).toBe(0)
    expect(clock.now()).toBe(T0 + 1000)

    await clock.setTime('2025-12-31T00:00:00Z')
    expect(clock.now()).toBe(Date.parse('2025-12-31T00:00:00Z'))

    await clock.tick(0)
    expect(fired).toBe(0)
  })

  it('a synchronous throw propagates out of tick and leaves the clock usable', async function () {
    const clock = new TestClock(T0)
    clock.setTimeout(() => { throw new Error('tester bug') }, 10)
    let after = 0
    clock.setTimeout(() => after++, 20)

    await expect(clock.tick(30)).rejects.toThrow('tester bug')
    expect(clock.now()).toBe(T0 + 10)

    await clock.tick(30)
    expect(after).toBe(1)
  })

  it('drives clockDelay', async function () {
    const clock = new TestClock(T0)
    let settled = false
    const promise = clockDelay(clock, 500).then(() => { settled = true })

    await clock.tick(499)
    expect(settled).toBe(false)

    await clock.tick(1)
    await promise
    expect(settled).toBe(true)
  })

  it('rejects an unparseable start time', function () {
    expect(() => new TestClock('not a date')).toThrow('invalid time')
  })
})
