import { delay } from '../src/tools.ts'
import assert from 'node:assert'
import * as helper from './testHelper.js'

describe('manager', function () {
  it('should reject multiple simultaneous start requests', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    await boss.start()

    await delay(2000)

    try {
      await boss.start()
      assert(false)
    } catch (error) {
      assert(true)
    }
  })
})
