const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');

describe('initialization', function(){

    beforeEach(function(finished) {
        helper.init()
            .then(() => finished());
    });

    it('should allow a 50 character custom schema name', function(finished){

        let config = helper.getConfig();

        config.schema = 'thisisareallylongschemanamefortestingmaximumlength';

        new PgBoss(config).start()
            .then(boss => {
                assert(true);
                boss.stop().then(() => finished());
            })
            .catch(error => {
                assert(false, error.message);
                finished();
            });

    });

    it('should not allow a 51 character custom schema name', function(){

        let config = helper.getConfig();

        config.schema = 'thisisareallylongschemanamefortestingmaximumlengthb';

        assert.throws(function () {
            let boss = new PgBoss(config);
        });

    });
});
