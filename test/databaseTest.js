var assert = require('chai').assert;
var PgBoss = require('../src/index');

describe('database', function(){
    it('should fail on invalid database host', function(finished){

        this.timeout(5000);

        var boss = new PgBoss('postgres://bobby:tables@wat:12345/northwind');

        boss.start()
            .then(() => {
                assert(false);
                finished();
            })
            .catch(() => {
                assert(true);
                finished();
            });
    });

});
