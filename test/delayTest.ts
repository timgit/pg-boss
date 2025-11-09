import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { delay } from '../src/tools.ts'

describe('delayed jobs', function () {
  it('should wait until after an int (in seconds)', async function () {
    this.boss = await helper.start(this.bossConfig)

    const startAfter = 2

    await this.boss.send(this.schema, null, { startAfter })

    const [job] = await this.boss.fetch(this.schema)

    assert(!job)

    await delay(startAfter * 1000)

    const [job2] = await this.boss.fetch(this.schema)

    assert(job2)
  })

  it('should wait until after a date time string', async function () {
    this.boss = await helper.start(this.bossConfig)

    const date = new Date()

    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date.toISOString()

    await this.boss.send(this.schema, null, { startAfter })

    const [job] = await this.boss.fetch(this.schema)

    assert(!job)

    await delay(5000)

    const job2 = await this.boss.fetch(this.schema)

    assert(job2)
  })

  it('should wait until after a date object', async function () {
    this.boss = await helper.start(this.bossConfig)

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await this.boss.send(this.schema, null, { startAfter })

    const [job] = await this.boss.fetch(this.schema)

    assert(!job)

    await delay(2000)

    const [job2] = await this.boss.fetch(this.schema)

    assert(job2)
  })

  it('should work with sendAfter() and a date object', async function () {
    this.boss = await helper.start(this.bossConfig)

    const date = new Date()
    date.setUTCSeconds(date.getUTCSeconds() + 2)

    const startAfter = date

    await this.boss.sendAfter(this.schema, { something: 1 }, { retryLimit: 0 }, startAfter)

    const [job] = await this.boss.fetch(this.schema)

    assert(!job)

    await delay(2000)

    const [job2] = await this.boss.fetch(this.schema)

    assert(job2)
  })
})
