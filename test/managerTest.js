import assert from 'node:assert'
import { delay } from '../src/tools.ts'
import { start } from './testHelper.js'

describe('manager', () => {
  it('should reject multiple simultaneous start requests', async function () {
    const boss = (this.test.boss = await start(this.test.bossConfig))

    await boss.start()

    await delay(2000)

    try {
      await boss.start()
      assert(false)
    } catch (_error) {
      assert(true)
    }
  })
})
