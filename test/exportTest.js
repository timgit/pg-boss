const assert = require('chai').assert
const PgBoss = require('../src/index')

describe('export', function () {
  it('should export commands to manually build schema', function () {
    const schema = 'custom'
    const plans = PgBoss.getConstructionPlans(schema)

    assert.include(plans, schema + '.job')
    assert.include(plans, schema + '.version')
  })
})
