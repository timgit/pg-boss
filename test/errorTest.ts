import * as helper from './testHelper.ts'

describe('error', function () {
  it('should handle an error in a worker and not blow up', async function () {
    this.boss = await helper.start(this.bossConfig)

    let processCount = 0

    await this.boss.send(this.schema)
    await this.boss.send(this.schema)

    await new Promise((resolve) => {
      this.boss.work(this.schema, async () => {
        processCount++

        if (processCount === 1) {
          throw new Error('test - nothing to see here')
        } else {
          resolve()
        }
      })
    })
  })
})
