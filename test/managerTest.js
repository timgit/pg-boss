const Promise = require("bluebird");
const assert = require('chai').assert;
const helper = require('./testHelper');
const PgBoss = require('../src/index');

describe('manager', function(){

    before(function(finished){
       helper.init().then(() => finished());
    });

    it('should reject multiple simultaneous start requests', function(finished) {

        const boss = new PgBoss(helper.getConfig());

        boss.start()
            .then(() => Promise.delay(1000))
            .then(() => boss.stop())
            .then(() => finished());

        boss.start()
            .catch(() => {
                assert(true);
            });

    });

});



