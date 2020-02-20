const assert = require('assert')
const helper = require('./testHelper')
const Promise = require('bluebird')
const PgBoss = require('../')
const Contractor = require('../src/contractor')
const currentSchemaVersion = require('../version.json').schema

describe('multi-master', function () {
  it('should only allow 1 master to start at a time', async function () {
    const replicaCount = 5
    const config = { ...this.test.bossConfig, noSupervisor: true }
    const instances = new Array(replicaCount)

    instances.forEach((i, index) => {
      instances[index] = new PgBoss(config)
    })

    try {
      await Promise.all(instances.map(i => i.start()))
    } catch (err) {
      console.log(err.message)
      assert(false)
    } finally {
      await Promise.all(instances.map(i => i.stop()))
    }
  })

  it('should only allow 1 master to migrate to latest at a time', async function () {
    const replicaCount = 5
    const config = { ...this.test.bossConfig, noSupervisor: true }
    const instances = new Array(replicaCount)

    instances.forEach((i, index) => {
      instances[index] = new PgBoss(config)
    })

    const db = await helper.getDb()
    const contractor = new Contractor(db, helper.getConfig())

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)
    const oldVersion = await contractor.version()

    assert.notStrictEqual(oldVersion, currentSchemaVersion)

    try {
      await Promise.all(instances.map(i => i.start()))
    } catch (err) {
      console.log(err.message)
      assert(false)
    } finally {
      await Promise.all(instances.map(i => i.stop()))
    }
  })
})
