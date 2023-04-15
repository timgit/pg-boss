const helper = require('./testHelper')

describe('error', function () {
  it('should handle an error in a worker and not blow up', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    let processCount = 0

    await boss.send(queue)
    await boss.send(queue)

    await new Promise((resolve) => {
      boss.work(queue, async job => {
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
