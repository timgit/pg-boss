const assert = require('chai').assert
const PgBoss = require('../src/index')
const currentSchemaVersion = require('../version.json').schema

describe('export', function () {
  it('should export commands to manually build schema', function () {
    const schema = 'custom'
    const plans = PgBoss.getConstructionPlans(schema)

    assert.include(plans, schema + '.job')
    assert.include(plans, schema + '.version')
  })

  it('should export commands to migrate', function () {
    const schema = 'custom'
    const plans = PgBoss.getMigrationPlans(schema, currentSchemaVersion - 1)

    assert(plans, 'migration plans not found')
  })

  it('should export commands to roll back', function () {
    const schema = 'custom'
    const plans = PgBoss.getRollbackPlans(schema, currentSchemaVersion)

    assert(plans, 'rollback plans not found')
  })
})
