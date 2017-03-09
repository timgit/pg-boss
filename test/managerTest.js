var assert = require('chai').assert;
var helper = require('./testHelper');
var PgBoss = require('../src/index');

describe('manager', function(){

    before(function(finished){
       helper.init().then(() => finished());
    });

    it('should reject multiple simultaneous start requests', function(finished) {

        var boss = new PgBoss(helper.getConfig());

        boss.start()
            .then(() => new Promise(resolve => setTimeout(() => boss.stop().then(resolve), 1000)))
            .then(() => finished());

        boss.start()
            .catch(() => {
                assert(true);
            });

    });

});



