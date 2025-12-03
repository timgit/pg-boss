const assert = require('node:assert')

describe('tools.unwrapSQLResult', function () {
  it('should return the same object when input is an object with rows', function () {
    const { unwrapSQLResult } = require('../src/tools')

    const input = { rows: [{ id: 1 }, { id: 2 }] }
    const output = unwrapSQLResult(input)

    assert.strictEqual(output, input)
    assert.deepStrictEqual(output, input)
  })

  it('should flatten an array of results into a single rows array', function () {
    const { unwrapSQLResult } = require('../src/tools')

    const part1 = { rows: [{ id: 'a' }] }
    const part2 = { rows: [{ id: 'b' }, { id: 'c' }] }
    const output = unwrapSQLResult([part1, part2])

    assert.deepStrictEqual(output, { rows: [part1.rows, part2.rows].flat() })
  })

  it('should handle empty array by returning empty rows', function () {
    const { unwrapSQLResult } = require('../src/tools')

    const output = unwrapSQLResult([])
    assert.deepStrictEqual(output, { rows: [] })
  })
})

describe('tools.delay', function () {
  it('should resolve after the specified delay', async function () {
    const { delay } = require('../src/tools')

    const start = Date.now()
    await delay(100)
    const elapsed = Date.now() - start

    assert(elapsed >= 90, `Expected delay of at least 90ms, got ${elapsed}ms`)
  })

  it('should be abortable', async function () {
    const { delay } = require('../src/tools')

    const promise = delay(1000)
    const start = Date.now()

    setTimeout(() => promise.abort(), 50)

    await promise
    const elapsed = Date.now() - start

    assert(elapsed < 200, `Expected early abort, but took ${elapsed}ms`)
  })

  it('should support extend to reset the timeout', async function () {
    const { delay } = require('../src/tools')

    const promise = delay(100, 'timeout')
    const start = Date.now()

    setTimeout(() => promise.extend(200), 50)

    try {
      await promise
      assert.fail('Expected timeout error')
    } catch (err: any) {
      const elapsed = Date.now() - start
      // Should have taken ~250ms (50ms + 200ms) instead of 100ms
      assert(elapsed >= 200, `Expected extended delay, got ${elapsed}ms`)
      assert.strictEqual(err.message, 'timeout')
    }
  })

  it('should not extend if already settled', async function () {
    const { delay } = require('../src/tools')

    const promise = delay(50)
    await promise

    // This should be a no-op and not throw
    promise.extend(1000)
  })
})

describe('tools.resolveWithinSeconds', function () {
  it('should return ExtendableTimeout with promise, abort, and extend', function () {
    const { resolveWithinSeconds } = require('../src/tools')

    const result = resolveWithinSeconds(Promise.resolve('test'), 10)

    assert(typeof result.promise.then === 'function', 'Expected promise property')
    assert(typeof result.abort === 'function', 'Expected abort method')
    assert(typeof result.extend === 'function', 'Expected extend method')
  })

  it('should resolve with the promise result', async function () {
    const { resolveWithinSeconds } = require('../src/tools')

    const result = resolveWithinSeconds(Promise.resolve('success'), 10)
    const value = await result.promise

    assert.strictEqual(value, 'success')
  })

  it('should timeout if promise takes too long', async function () {
    const { resolveWithinSeconds, delay } = require('../src/tools')

    const slowPromise = delay(5000)
    const result = resolveWithinSeconds(slowPromise, 1, 'timed out')

    try {
      await result.promise
      assert.fail('Expected timeout error')
    } catch (err: any) {
      assert.strictEqual(err.message, 'timed out')
    }
  })

  it('should allow extending the timeout', async function () {
    const { resolveWithinSeconds, delay } = require('../src/tools')

    const slowPromise = (async () => {
      await delay(200)
      return 'done'
    })()

    // Initial timeout of 100ms (would timeout normally)
    const result = resolveWithinSeconds(slowPromise, 0.1, 'timed out')

    setTimeout(() => result.extend(500), 50)

    const value = await result.promise
    assert.strictEqual(value, 'done')
  })
})
