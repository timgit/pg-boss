const assert = require('assert')
const helper = require('./testHelper')
const { randomUUID } = require('crypto')

describe('ops', function () {
  it('should expire manually', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    await boss.expire()
  })

  it('should archive manually', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    await boss.archive()
  })

  it('should purge the archive manually', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    await boss.drop()
  })

  it('should emit error in worker', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, __test__throw_worker: true })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    await boss.work(queue, () => {})

    await new Promise(resolve => boss.once('error', resolve))
  })

  it('should return null from getJobById if not found', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })

    const jobId = await boss.getJobById(randomUUID())

    assert.strictEqual(jobId, null)
  })

  it('should force stop', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    await boss.stop({ graceful: false, wait: false })
  })

  it('should destroy the connection pool', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    await boss.stop({ destroy: true, graceful: false, wait: false })

    assert(boss.db.pool.totalCount === 0)
  })

  it('should destroy the connection pool gracefully', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig })
    await boss.stop({ destroy: true, wait: false })
    await new Promise((resolve) => {
      boss.on('stopped', () => resolve())
    })

    assert(boss.db.pool.totalCount === 0)
  })
})
