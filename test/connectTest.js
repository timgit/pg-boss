var assert = require('chai').assert;
var helper = require('./testHelper');

describe('connect', function() {

    var boss;

    beforeEach(function(finished){
        helper.start()
            .then(dabauce => {
                boss = dabauce;
                finished();
            });
    });

    afterEach(function(finished){
        boss.stop().then(() => finished());
    });

    it('should fail if connecting to an older schema version', function (finished) {
        helper.getDb().executeSql(`UPDATE ${helper.config.schema}.version SET VERSION = '0.0.0'`)
            .then(() => {
                boss.connect().catch(error => {
                    assert.isNotNull(error);
                    finished();
                });
            });
    });

    it('should succeed if already started', function (finished) {
        boss.connect().then(() => {
            assert(true);
            finished();
        });
    });

});
