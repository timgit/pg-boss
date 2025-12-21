import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'
import { testContext } from './hooks.ts'

describe('delayed jobs', function () {
  it('should wait until after an int (in seconds)', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const startAfter = 2

    await testContext.boss.send(testContext.schema, null, { startAfter })

    const [job] = await testContext.boss.fetch(testContext.schema)

    assert(!job)

    await delay(startAfter * 1000)

    const [job2] = await testContext.boss.fetch(testContext.schema)

    assert(job2)
  })

  it('should wait until after a date time string', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const date = new Date()

    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date.toISOString()

    await testContext.boss.send(testContext.schema, null, { startAfter })

    const [job] = await testContext.boss.fetch(testContext.schema)

    assert(!job)

    await delay(5000)

    const job2 = await testContext.boss.fetch(testContext.schema)

    assert(job2)
  })

  it('should wait until after a date object', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await testContext.boss.send(testContext.schema, null, { startAfter })

    const [job] = await testContext.boss.fetch(testContext.schema)

    assert(!job)

    await delay(2000)

    const [job2] = await testContext.boss.fetch(testContext.schema)

    assert(job2)
  })

  it('should work with sendAfter() and a date object', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await testContext.boss.sendAfter(testContext.schema, { something: 1 }, { retryLimit: 0 }, startAfter)

    const [job] = await testContext.boss.fetch(testContext.schema)

    assert(!job)

    await delay(2000)

    const [job2] = await testContext.boss.fetch(testContext.schema)

    assert(job2)
  })
})
