import assert from 'node:assert'
import { getDb } from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import Contractor from '../src/contractor.ts'
import { getAll } from '../src/migrationStore.ts'
import packageJson from '../package.json' with { type: 'json' }

const currentSchemaVersion = packageJson.pgboss.schema

describe('multi-master', function () {
  it('should only allow 1 master to start at a time', async function () {
    const replicaCount = 20
    const config = { ...this.bossConfig, supervise: true, max: 2 }
    const instances = []

    for (let i = 0; i < replicaCount; i++) {
      instances.push(new PgBoss(config))
    }

    await Promise.all(instances.map(i => i.start()))
    await Promise.all(instances.map(i => i.stop({ graceful: false })))
  })

  it.skip('should only allow 1 master to migrate to latest at a time', async function () {
    const config = {
      ...this.bossConfig,
      supervise: true,
      superviseIntervalSeconds: 1,
      max: 2
    }

    const db = await getDb()
    const contractor = new Contractor(db, config)

    await contractor.create()

    await contractor.rollback(currentSchemaVersion)

    const oldVersion = await contractor.schemaVersion()

    assert.notStrictEqual(oldVersion, currentSchemaVersion)

    config.migrations = getAll(config.schema)
    config.migrations[0].install.push('select pg_sleep(1)')

    const instances = []

    for (let i = 0; i < 5; i++) {
      instances.push(new PgBoss(config))
    }

    await Promise.all(instances.map(i => i.start()))
    await Promise.all(instances.map(i => i.stop({ graceful: false })))
  })
})
