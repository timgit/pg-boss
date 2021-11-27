const helper = require('./testHelper')

describe('error', function () {
  it('should handle an error in a processr and not blow up', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'error-handling'

    let processCount = 0

    await boss.send(queue)
    await boss.send(queue)

    return new Promise((resolve) => {
      boss.process(queue, async job => {
        processCount++

        if (processCount === 1) {
          throw new Error('test - nothing to see here')
        } else {
          job.done()
          resolve()
        }
      })
    })
  })
})
