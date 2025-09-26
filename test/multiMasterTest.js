const assert = require('node:assert')
const helper = require('./testHelper')
const PgBoss = require('../')
const Contractor = require('../src/contractor')
const migrationStore = require('../src/migrationStore')
const currentSchemaVersion = require('../version.json').schema

describe('multi-master', function () {
  it('should only allow 1 master to start at a time', async function () {
    const replicaCount = 20
    const config = { ...this.test.bossConfig, supervise: false, max: 2 }
    const instances = []

    for (let i = 0; i < replicaCount; i++) {
      instances.push(new PgBoss(config))
    }

    try {
      await Promise.all(instances.map(i => i.start()))
    } catch (err) {
      assert(false, err.message)
    } finally {
      await Promise.all(instances.map(i => i.stop({ graceful: false, wait: false })))
    }
  })

  it.skip('should only allow 1 master to migrate to latest at a time', async function () {
    const config = {
      ...this.test.bossConfig,
      supervise: true,
      superviseIntervalSeconds: 1,
      max: 2
    }

    const db = await helper.getDb()
    const contractor = new Contractor(db, config)

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const oldVersion = await contractor.schemaVersion()

    assert.notStrictEqual(oldVersion, currentSchemaVersion)

    config.migrations = migrationStore.getAll(config.schema)
    config.migrations[0].install.push('select pg_sleep(1)')

    const instances = []

    for (let i = 0; i < 5; i++) {
      instances.push(new PgBoss(config))
    }

    try {
      await Promise.all(instances.map(i => i.start()))
    } catch (err) {
      assert(false)
    } finally {
      await Promise.all(instances.map(i => i.stop({ graceful: false, wait: false })))
    }
  })
})
