var assert = require('chai').assert;
var PgBoss = require('../lib/index');

describe('schema export', function(){
   it('should export commands to manually build schema', function() {
       var schema = 'custom';
       var plans = PgBoss.getConstructionPlans(schema);

       assert.include(plans, schema + '.job');
       assert.include(plans, schema + '.version');
   });
});
