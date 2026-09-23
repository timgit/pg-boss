import { expect } from 'vitest'
import { TestClock } from '../src/clock.ts'
import { clockDelay } from '../src/tools.ts'

const T0 = Date.parse('2026-01-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000

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

  it('a forward setTime fires an overdue interval once, then keeps its period', async function () {
    const clock = new TestClock(T0)
    let fired = 0
    clock.setInterval(() => fired++, 2000)

    await clock.tick(500)
    await clock.setTime(T0 + DAY)

    await clock.tick(0)
    expect(fired).toBe(1)

    await clock.tick(1999)
    expect(fired).toBe(1)

    await clock.tick(1)
    expect(fired).toBe(2)
    expect(clock.now()).toBe(T0 + DAY + 2000)
  })

  it('a forward setTime fires overdue timers in their original order, ahead of timers set after it', async function () {
    const clock = new TestClock(T0)
    const fired: string[] = []

    clock.setTimeout(() => fired.push('at jump'), DAY)
    clock.setTimeout(() => fired.push('b@20'), 20)
    clock.setTimeout(() => fired.push('a@10'), 10)

    await clock.setTime(T0 + DAY)
    clock.setTimeout(() => fired.push('after jump'), 0)
    await clock.tick(0)

    expect(fired).toEqual(['a@10', 'b@20', 'at jump', 'after jump'])
  })

  it('a backward setTime leaves timers at their due time', async function () {
    const clock = new TestClock(T0)
    let fired = 0
    clock.setTimeout(() => fired++, 10)

    await clock.setTime(T0 - 1000)

    await clock.tick(1009)
    expect(fired).toBe(0)

    await clock.tick(1)
    expect(fired).toBe(1)
  })

  it('rejects a setTime while a tick is in progress', async function () {
    const clock = new TestClock(T0)
    let nested: Promise<unknown> | undefined

    clock.setTimeout(() => { nested = clock.setTime(T0 + DAY).catch(err => err) }, 10)
    await clock.tick(20)

    expect(await nested).toMatchObject({ message: 'TestClock: setTime() called while a tick is in progress' })
    expect(clock.now()).toBe(T0 + 20)
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

  it('seeds the row in the same batch that installs the override', async function () {
    const texts: string[] = []
    const db = {
      executeSql: async (text: string) => {
        texts.push(text)
        return { rows: [] }
      }
    }

    const clock = new TestClock(T0)
    await clock.attach({ db, schema: 'pgboss' })

    // Two round trips would leave the override reading an empty table in between, and its body
    // falls back to pg_catalog.now() when it finds no row - real time, silently, to anything that
    // called job_now() in the gap.
    const installs = texts.filter(text => text.includes('CREATE OR REPLACE FUNCTION'))
    expect(installs).toHaveLength(1)
    expect(installs[0]).toContain('INSERT INTO')
    expect(texts.filter(text => text.includes('INSERT INTO'))).toHaveLength(1)

    // The literal carries the clock's start time, since a multi-statement batch cannot take params.
    expect(installs[0]).toContain(`to_timestamp(${T0 / 1000})`)
  })

  it('rejects an unparseable start time', function () {
    expect(() => new TestClock('not a date')).toThrow('invalid time')
  })

  describe('settling attached targets', function () {
    const fakeDb = { executeSql: async () => ({ rows: [] }) }

    // A target that is busy while `pending` is set, like an instance with a statement in flight.
    function busyTarget () {
      const state: { pending: Promise<void> | null } = { pending: null }
      const idle = async () => {
        if (!state.pending) return false
        await state.pending
        state.pending = null
        return true
      }
      return { state, idle }
    }

    const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

    it('settles after each fired timer, so a re-armed poll due by the target fires in the same tick', async function () {
      const clock = new TestClock(T0)
      const target = busyTarget()
      await clock.attach({ db: fakeDb, schema: 'pgboss', idle: target.idle })
      const fired: number[] = []

      const poll = () => {
        fired.push(clock.now() - T0)
        target.state.pending = later(20).then(() => { clock.setTimeout(poll, 100) })
      }
      clock.setTimeout(poll, 100)

      await clock.tick(250)
      expect(fired).toEqual([100, 200])
    })

    it('settles before firing, so a timer armed by earlier work still fires', async function () {
      const clock = new TestClock(T0)
      const target = busyTarget()
      await clock.attach({ db: fakeDb, schema: 'pgboss', idle: target.idle })
      const fired: string[] = []

      target.state.pending = later(20).then(() => { clock.setTimeout(() => fired.push('late'), 50) })

      await clock.tick(100)
      expect(fired).toEqual(['late'])
    })

    it('repeats until every target is quiet in the same pass', async function () {
      const clock = new TestClock(T0)
      const a = busyTarget()
      const b = busyTarget()
      await clock.attach({ db: fakeDb, schema: 'a', idle: a.idle })
      await clock.attach({ db: fakeDb, schema: 'b', idle: b.idle })
      const fired: string[] = []

      // A going quiet is what wakes B, after B's first idle() has already said false.
      a.state.pending = later(20).then(() => {
        b.state.pending = later(20).then(() => { clock.setTimeout(() => fired.push('b'), 50) })
      })

      await clock.tick(100)
      expect(fired).toEqual(['b'])
    })

    it('setTime settles before it jumps', async function () {
      const clock = new TestClock(T0)
      const target = busyTarget()
      await clock.attach({ db: fakeDb, schema: 'pgboss', idle: target.idle })
      const fired: string[] = []

      target.state.pending = later(20).then(() => { clock.setTimeout(() => fired.push('armed before the jump'), 10) })

      await clock.setTime(T0 + 1000)
      await clock.tick(0)
      expect(fired).toEqual(['armed before the jump'])
    })

    it('a long tick across a short interval stays fast', async function () {
      const clock = new TestClock(T0)
      await clock.attach({ db: fakeDb, schema: 'pgboss', idle: async () => false })
      let count = 0
      clock.setInterval(() => count++, 2000)

      const started = performance.now()
      await clock.tick(60 * 60 * 1000)

      expect(count).toBe(1800)
      expect(performance.now() - started).toBeLessThan(5000)
    })

    it('a target disposed from a timer callback does not stall the tick', async function () {
      const clock = new TestClock(T0)
      const handle = await clock.attach({ db: fakeDb, schema: 'pgboss', idle: async () => false })
      const fired: number[] = []

      clock.setTimeout(() => { fired.push(1); handle[Symbol.asyncDispose]() }, 10)
      clock.setTimeout(() => fired.push(2), 20)

      await clock.tick(30)
      expect(fired).toEqual([1, 2])
    })
  })
})
