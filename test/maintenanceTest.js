const assert = require('assert')
const helper = require('./testHelper')
const delay = require('delay')
const PgBoss = require('../')

describe('maintenance', async function () {
  it('should send maintenance job if missing during monitoring', async function () {
    const config = { ...this.test.bossConfig, maintenanceIntervalSeconds: 1 }

    const db = await helper.getDb()

    const boss = this.test.boss = new PgBoss(config)

    const queues = boss.boss.getQueueNames()
    const countJobs = () => helper.countJobs(config.schema, 'name = $1', [queues.MAINTENANCE])

    await boss.start()

    boss.on('maintenance', async () => {
      // force timestamp to an older date
      await db.executeSql(`UPDATE ${config.schema}.version SET maintained_on = now() - interval '5 minutes'`)
    })

    // wait for monitoring to check timestamp
    await delay(4000)

    const count = await countJobs()
    assert(count > 1)
  })

  it('meta monitoring error handling works', async function () {
    const config = {
      ...this.test.bossConfig,
      maintenanceIntervalSeconds: 1,
      __test__throw_meta_monitor: 'meta monitoring error'
    }

    let errorCount = 0

    const boss = this.test.boss = new PgBoss(config)

    boss.once('error', (error) => {
      assert.strictEqual(error.message, config.__test__throw_meta_monitor)
      errorCount++
    })

    await boss.start()

    await delay(6000)

    assert.strictEqual(errorCount, 1)
  })
})
