const helper = require('./testHelper')

describe('error', function () {
  it('should handle an error in a subscriber and not blow up', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    const queue = 'error-handling'

    let subscribeCount = 0

    await boss.publish(queue)
    await boss.publish(queue)

    return new Promise((resolve) => {
      boss.subscribe(queue, async job => {
        subscribeCount++

        if (subscribeCount === 1) {
          throw new Error('test - nothing to see here')
        } else {
          job.done()
          resolve()
        }
      })
    })
  })
})
