var assert = require('chai').assert;
var PgBoss = require('../src/index');
var helper = require('./testHelper');

describe('connect', function() {

    var boss;

    before(function(finished){
        helper.start()
            .then(dabauce => {
                boss = dabauce;
                finished();
            });
    });

    it('should fail if connecting to an older schema version', function (finished) {

        helper.getDb().executeSql(`UPDATE ${helper.config.schema}.version SET VERSION = '0.0.0'`)
            .then(() => {
                boss.on('error', function (error) {
                    assert.isNotNull(error);
                    finished();
                });

                boss.connect();
            });
    });

});
