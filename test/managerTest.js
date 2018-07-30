const Promise = require('bluebird');
const assert = require('chai').assert;
const helper = require('./testHelper');
const PgBoss = require('../src/index');

describe('manager', function(){

  this.timeout(10000);

  before(function(finished){
    helper.init().then(() => finished());
  });

  it('should reject multiple simultaneous start requests', function(finished) {

    const boss = new PgBoss(helper.getConfig());

    boss.start()
      .then(() => Promise.delay(2000))
      .then(() => boss.start())
      .catch(() => boss.stop().then(() => finished()))

  });

});



