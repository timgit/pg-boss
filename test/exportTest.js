const assert = require('assert')
const PgBoss = require('../')
const currentSchemaVersion = require('../version.json').schema

describe('export', function () {
  it('should export commands to manually build schema', function () {
    const schema = 'custom'
    const plans = PgBoss.getConstructionPlans(schema)

    assert(plans.includes(`${schema}.job`))
    assert(plans.includes(`${schema}.version`))
  })

  it('should fail to export migration using current version', function () {
    const schema = 'custom'

    try {
      PgBoss.getMigrationPlans(schema, currentSchemaVersion)
      assert(false, 'migration plans should fail on current version')
    } catch {
      assert(true)
    }
  })

  it.skip('should export commands to migrate', function () {
    const schema = 'custom'
    const plans = PgBoss.getMigrationPlans(schema, currentSchemaVersion - 1)

    assert(plans, 'migration plans not found')
  })

  it('should fail to export commands to roll back from invalid version', function () {
    const schema = 'custom'

    try {
      PgBoss.getRollbackPlans(schema, -1)
      assert(false, 'migration plans should fail on current version')
    } catch {
      assert(true)
    }
  })

  it.skip('should export commands to roll back', function () {
    const schema = 'custom'
    const plans = PgBoss.getRollbackPlans(schema, currentSchemaVersion)

    assert(plans, 'rollback plans not found')
  })
})
