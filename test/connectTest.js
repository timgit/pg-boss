const assert = require('chai').assert;
const helper = require('./testHelper');

describe('connect', function() {

  this.timeout(10000);

  let boss;

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
    let schema = helper.getConfig().schema;

    helper.getDb().executeSql(`UPDATE ${schema}.version SET VERSION = '0.0.0'`)
      .then(() => {
        boss.connect().catch(error => {
          assert.isNotNull(error);
          finished();
        });
      });
  });

  it('should succeed if already started', function (finished) {
    boss.connect()
      .then(() => boss.disconnect())
      .then(() => {
        assert(true);
        finished();
      });
  });

});
