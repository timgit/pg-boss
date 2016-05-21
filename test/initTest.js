var assert = require('chai').assert;
var PgBoss = require('../src/index');
var helper = require('./testHelper');

describe('initialization', function(){
    
    beforeEach(function(finished) {
        helper.init()
            .then(() => finished());
    });
    
    it('should fail if connecting to an uninitialized instance', function(finished) {
        new PgBoss(helper.config).connect()
            .catch(error => {
                assert.isNotNull(error);
                finished();
            });
    });

    it('should start with a connection string', function(finished) {
        new PgBoss(helper.connectionString).start()
            .then(() => {
                assert(true);
                finished();
            });
    });
});
