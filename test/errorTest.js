const helper = require('./testHelper')

describe('error', function () {
  this.timeout(10000)

  let boss

  before(async function () { boss = await helper.start() })
  after(async function () { await boss.stop() })

  it('should handle an error in a subscriber and not blow up', function (finished) {
    test()

    async function test () {
      const queue = 'error-handling'
      let subscribeCount = 0

      await boss.publish(queue)
      await boss.publish(queue)

      boss.subscribe(queue, async job => {
        subscribeCount++

        if (subscribeCount === 1) {
          throw new Error('test - nothing to see here')
        } else {
          await job.done()
          finished()
        }
      })
    }
  })
})
