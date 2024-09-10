const assert = require('node:assert')
const helper = require('./testHelper')
const { randomUUID } = require('crypto')

describe('ops', function () {
  it('should emit error in worker', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, __test__throw_worker: true })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    await boss.work(queue, () => {})

    await new Promise(resolve => boss.once('error', resolve))
  })

  it('should return null from getJobById if not found', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.getJobById(queue, randomUUID())

    assert(!jobId)
  })

  it('should force stop', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    await boss.stop({ graceful: false, wait: true })
  })

  it('should close the connection pool', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    await boss.stop({ graceful: false, wait: true })

    assert(boss.getDb().pool.totalCount === 0)
  })

  it('should close the connection pool gracefully', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    await boss.stop({ wait: true })

    assert(boss.getDb().pool.totalCount === 0)
  })

  it('should not close the connection pool after stop with close option', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    const queue = this.test.bossConfig.schema
    await boss.stop({ close: false, wait: true })

    const jobId = await boss.send(queue)
    const [job] = await boss.fetch(queue)

    assert.strictEqual(jobId, job.id)
  })
})
