var assert = require('chai').assert;
var PgBoss = require('../src/index');
var config = require('./config.json');
var helper = require('./testHelper');

describe('initialization', function(){
    it('should fail if connecting to an uninitialized instance', function(finished) {

        helper.getDb().executeSql(`DROP SCHEMA IF EXISTS ${config.schema} CASCADE`)
            .then(() => {
                var boss = new PgBoss(helper.config);

                boss.on('error', function(error) {
                    assert.isNotNull(error);
                    finished();
                });

                boss.connect();
            });

    });

    it('should start with a connection string', function(finished) {

        helper.getDb().executeSql(`DROP SCHEMA IF EXISTS ${config.schema} CASCADE`)
            .then(() => {
                var boss = new PgBoss(helper.connectionString);

                boss.on('ready', function() {
                    assert(true);
                    finished();
                });

                boss.start();
            });

    });

});
