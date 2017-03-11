const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');

describe('initialization', function(){
    
    beforeEach(function(finished) {
        helper.init()
            .then(() => finished());
    });
    
    it('should fail if connecting to an uninitialized instance', function(finished) {
        new PgBoss(helper.getConfig()).connect()
            .catch(error => {
                assert.isNotNull(error);
                finished();
            });
    });

    it('should start with a connection string', function(finished) {
        new PgBoss(helper.getConnectionString()).start()
            .then(boss => {
                assert(true);
                boss.stop().then(() => finished());
            });
    });
});
