import assert, { notStrictEqual } from 'node:assert'
import Contractor from '../src/contractor.js'
import PgBoss from '../src/index.js'
import { getAll } from '../src/migrationStore.js'
import version from '../version.json'
import { getDb } from './testHelper.js'

const currentSchemaVersion = version.schema

describe('multi-master', () => {
  it('should only allow 1 master to start at a time', async function () {
    const replicaCount = 20
    const config = { ...this.test.bossConfig, supervise: false, max: 2 }
    const instances = []

    for (let i = 0; i < replicaCount; i++) {
      instances.push(new PgBoss(config))
    }

    try {
      await Promise.all(instances.map((i) => i.start()))
    } catch (err) {
      assert(false, err.message)
    } finally {
      await Promise.all(
        instances.map((i) => i.stop({ graceful: false, wait: false }))
      )
    }
  })

  it.skip('should only allow 1 master to migrate to latest at a time', async function () {
    const config = {
      ...this.test.bossConfig,
      supervise: true,
      superviseIntervalSeconds: 1,
      max: 2
    }

    const db = await getDb()
    const contractor = new Contractor(db, config)

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const oldVersion = await contractor.schemaVersion()

    notStrictEqual(oldVersion, currentSchemaVersion)

    config.migrations = getAll(config.schema)
    config.migrations[0].install.push('select pg_sleep(1)')

    const instances = []

    for (let i = 0; i < 5; i++) {
      instances.push(new PgBoss(config))
    }

    try {
      await Promise.all(instances.map((i) => i.start()))
    } catch (_err) {
      assert(false)
    } finally {
      await Promise.all(
        instances.map((i) => i.stop({ graceful: false, wait: false }))
      )
    }
  })
})
