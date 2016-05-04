var assert = require('chai').assert;
var PgBoss = require('../src/index');

describe('schema export', function(){
   it('should export commands to manually build schema', function() {
       var schema = 'custom';
       var plans = PgBoss.getConstructionPlans(schema);

       assert.include(plans, schema + '.job');
       assert.include(plans, schema + '.version');
   });

    it('should export migration commands from 0.0.1 to 0.1.0', function() {
        var schema = 'custom';
        var currentSchemaVersion = '0.0.1';
        var expectedMigrationVersion = '0.1.0';
        var plans = PgBoss.getMigrationPlans(schema, currentSchemaVersion);
        
        assert.include(plans, `ALTER TABLE ${schema}.job`);
        assert.include(plans, `UPDATE ${schema}.version SET version = '${expectedMigrationVersion}`);
    });
});
