// import whyIsNodeRunning from 'why-is-node-running'
import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { randomUUID } from 'node:crypto'
import { PgBoss } from '../src/index.ts'

describe('ops', function () {
  it('should emit error in worker', async function () {
    this.boss = await helper.start({ ...this.bossConfig, __test__throw_worker: true })

    await this.boss.send(this.schema)
    await this.boss.work(this.schema, () => {})

    await new Promise(resolve => this.boss.once('error', resolve))
  })

  it('should return null from getJobById if not found', async function () {
    this.boss = await helper.start(this.bossConfig)

    const jobId = await this.boss.getJobById(this.schema, randomUUID())

    assert(!jobId)
  })

  it('should force stop', async function () {
    this.boss = await helper.start(this.bossConfig)
    await this.boss.stop({ graceful: false, wait: true })
  })

  it('should close the connection pool', async function () {
    this.boss = await helper.start(this.bossConfig)
    await this.boss.stop({ graceful: false, wait: true })

    assert(this.boss.getDb().pool.totalCount === 0)
  })

  it('should close the connection pool gracefully', async function () {
    this.boss = await helper.start(this.bossConfig)
    await this.boss.stop({ wait: true })

    assert(this.boss.getDb().pool.totalCount === 0)
  })

  it('should not close the connection pool after stop with close option', async function () {
    this.boss = await helper.start(this.bossConfig)
    await this.boss.stop({ close: false, wait: true })

    const jobId = await this.boss.send(this.schema)
    const [job] = await this.boss.fetch(this.schema)

    assert.strictEqual(jobId, job.id)
  })

  it('should be able to run an arbitrary query via getDb()', async function () {
    this.boss = await helper.start(this.bossConfig)
    const { rows } = await this.boss.getDb().executeSql('select 1')
    assert.strictEqual(1, rows.length)
  })

  it('should start and stop immediately', async function () {
    const boss = new PgBoss(this.bossConfig)
    await boss.start()
    await boss.stop()
  })

  it.only('should not leave open handles after starting and stopping', async function () {
    const handlesBefore = (process as any)._getActiveHandles?.() || []
    const requestsBefore = (process as any)._getActiveRequests?.() || []

    // console.log('checking handles before test:')
    // whyIsNodeRunning()

    const boss = new PgBoss({ ...this.bossConfig, supervise: true, schedule: true })
    await boss.start()
    await boss.createQueue(this.schema)
    await boss.work(this.schema, async () => {})
    await boss.stop({ timeout: 5000 })

    // console.log('checking handles after test:')
    // whyIsNodeRunning()

    const handlesAfter = (process as any)._getActiveHandles?.() || []
    const requestsAfter = (process as any)._getActiveRequests?.() || []

    if (handlesAfter.length !== handlesBefore.length) {
      console.log('Handles before')
      console.log(handlesBefore)
      console.log('\n\nHandles after')
      console.log(handlesAfter)
    }

    assert.strictEqual(handlesAfter.length, handlesBefore.length, `Should not leave open handles. Before: ${handlesBefore.length}, After: ${handlesAfter.length}`)
    assert.strictEqual(requestsAfter.length, requestsBefore.length, `Should not leave open requests. Before: ${requestsBefore.length}, After: ${requestsAfter.length}`)
  })
})
