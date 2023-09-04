const assert = require('assert')
const helper = require('./testHelper')
const PgBoss = require('../')
const Contractor = require('../src/contractor')
const migrationStore = require('../src/migrationStore')
const currentSchemaVersion = require('../version.json').schema
const pMap = require('p-map')

describe('multi-master', function () {
  it('should only allow 1 master to start at a time', async function () {
    const replicaCount = 20
    const config = { ...this.test.bossConfig, max: 2 }
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
    const replicaCount = 5
    const config = { ...this.test.bossConfig, supervise: true, max: 2 }

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
})
