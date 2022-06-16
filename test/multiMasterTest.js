const assert = require('assert')
const pMap = require('p-map')
const delay = require('delay')
const helper = require('./testHelper')
const PgBoss = require('../')
const Contractor = require('../src/contractor')
const migrationStore = require('../src/migrationStore')
const currentSchemaVersion = require('../version.json').schema

describe('multi-master', function () {
  it('should only allow 1 master to start at a time', async function () {
    const replicaCount = 20
    const config = { ...this.test.bossConfig, noSupervisor: true, max: 2 }
    const instances = []

    for (let i = 0; i < replicaCount; i++) {
      instances.push(new PgBoss(config))
    }

    try {
      await pMap(instances, i => i.start())
    } catch (err) {
      assert(false, err.message)
    } finally {
      await pMap(instances, i => i.stop({ graceful: false }))
    }
  })

  it('should only allow 1 master to migrate to latest at a time', async function () {
    const replicaCount = 20
    const config = { ...this.test.bossConfig, noSupervisor: true, max: 2 }

    const db = await helper.getDb()
    const contractor = new Contractor(db, config)

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const oldVersion = await contractor.version()

    assert.notStrictEqual(oldVersion, currentSchemaVersion)

    config.migrations = migrationStore.getAll(config.schema)
    config.migrations[0].install.push('select pg_sleep(1)')

    const instances = []

    for (let i = 0; i < replicaCount; i++) {
      instances.push(new PgBoss(config))
    }

    try {
      await pMap(instances, i => i.start())
    } catch (err) {
      assert(false)
    } finally {
      await pMap(instances, i => i.stop({ graceful: false }))
    }
  })

  it('should clear maintenance queue before supervising', async function () {
    const { states } = PgBoss
    const jobCount = 5

    const defaults = {
      maintenanceIntervalSeconds: 1,
      noSupervisor: true
    }

    const config = { ...this.test.bossConfig, ...defaults }

    let boss = new PgBoss(config)

    const queues = boss.boss.getQueueNames()
    const countJobs = (state) => helper.countJobs(config.schema, 'name = $1 AND state = $2', [queues.MAINTENANCE, state])

    await boss.start()

    // create extra maintenace jobs manually
    for (let i = 0; i < jobCount; i++) {
      await boss.send(queues.MAINTENANCE)
    }

    const beforeCount = await countJobs(states.created)

    assert.strictEqual(beforeCount, jobCount)

    await boss.stop({ graceful: false })

    boss = new PgBoss(this.test.bossConfig)

    await boss.start()

    await delay(3000)

    const completedCount = await countJobs(states.completed)

    assert.strictEqual(completedCount, 1)

    await boss.stop({ graceful: false })
  })
})
