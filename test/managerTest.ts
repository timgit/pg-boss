import { delay } from '../src/tools.ts'
import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { type PgBoss } from '../src/index.ts'

describe('manager', function () {
  it('should reject multiple simultaneous start requests', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    await this.boss.start()

    await delay(2000)

    assert.rejects(async () => {
      await this.boss.start()
    })
  })
})
