const assert = require('assert')
const helper = require('./testHelper')

describe('queues', function () {
  it('should create a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
  })

  it('should reject a queue with invalid characters', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = `*${this.test.bossConfig.schema}`

    try {
      await boss.createQueue(queue)
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should reject a queue that starts with a number', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = `4${this.test.bossConfig.schema}`

    try {
      await boss.createQueue(queue)
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should reject a queue with invalid policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    try {
      await boss.createQueue(queue, { policy: 'something' })
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('should create a queue with standard policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'standard' })
  })

  it('should create a queue with stately policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'stately' })
  })

  it('should create a queue with singleton policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'singleton' })
  })

  it('should create a queue with short policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'short' })
  })

  it('should create a queue with priority policy', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue, { policy: 'priority' })
  })

  it('should delete a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.deleteQueue(queue)
  })

  it('should purge a queue', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    await boss.createQueue(queue)
    await boss.purgeQueue(queue)
  })
})
