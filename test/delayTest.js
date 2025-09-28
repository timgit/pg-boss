import assert from 'node:assert'
import { delay } from '../src/tools.ts'
import { start } from './testHelper.js'

describe('delayed jobs', () => {
  it('should wait until after an int (in seconds)', async function () {
    const boss = (this.test.boss = await start(this.test.bossConfig))
    const queue = this.test.bossConfig.schema

    const startAfter = 2

    await boss.send(queue, null, { startAfter })

    const [job] = await boss.fetch(queue)

    assert(!job)

    await delay(startAfter * 1000)

    const [job2] = await boss.fetch(queue)

    assert(job2)
  })

  it('should wait until after a date time string', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const date = new Date()

    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date.toISOString()

    await boss.send(queue, null, { startAfter })

    const [job] = await boss.fetch(queue)

    assert(!job)

    await delay(5000)

    const job2 = await boss.fetch(queue)

    assert(job2)
  })

  it('should wait until after a date object', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await boss.send(queue, null, { startAfter })

    const [job] = await boss.fetch(queue)

    assert(!job)

    await delay(2000)

    const [job2] = await boss.fetch(queue)

    assert(job2)
  })

  it('should work with sendAfter() and a date object', async function () {
    const boss = (this.test.boss = await start({ ...this.test.bossConfig }))
    const queue = this.test.bossConfig.schema

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await boss.sendAfter(
      queue,
      { something: 1 },
      { retryLimit: 0 },
      startAfter
    )

    const [job] = await boss.fetch(queue)

    assert(!job)

    await delay(2000)

    const [job2] = await boss.fetch(queue)

    assert(job2)
  })
})
