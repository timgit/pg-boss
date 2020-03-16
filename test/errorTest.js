const helper = require('./testHelper')

describe('error', function () {
  it('should handle an error in a subscriber and not blow up', function (finished) {
    const config = this.test.bossConfig

    test()

    async function test () {
      const queue = 'error-handling'
      let subscribeCount = 0

      const boss = await helper.start(config)

      await boss.publish(queue)
      await boss.publish(queue)

      boss.subscribe(queue, async job => {
        subscribeCount++

        if (subscribeCount === 1) {
          throw new Error('test - nothing to see here')
        } else {
          await job.done()
          await boss.stop()
          finished()
        }
      })
    }
  })
})
