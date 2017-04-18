const assert = require('chai').assert;
const PgBoss = require('../src/index');

describe('schema export', function(){
  it('should export commands to manually build schema', function() {
    const schema = 'custom';
    const plans = PgBoss.getConstructionPlans(schema);

    assert.include(plans, schema + '.job');
    assert.include(plans, schema + '.version');
  });

  it('should export migration commands from 0.0.1 to 0.1.0', function() {
    const schema = 'custom';
    const currentSchemaVersion = '0.0.1';
    const expectedMigrationVersion = '0.1.0';
    const plans = PgBoss.getMigrationPlans(schema, currentSchemaVersion);

    assert.include(plans, `ALTER TABLE ${schema}.job`);
    assert.include(plans, `UPDATE ${schema}.version SET version = '${expectedMigrationVersion}`);
  });
});
