const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');

describe('initialization', function(){

  this.timeout(10000);

  before(function(finished) {
    helper.init()
      .then(() => finished());
  });

  it('should allow a 50 character custom schema name', function(finished){

    let config = helper.getConfig();

    config.schema = 'thisisareallylongschemanamefortestingmaximumlength';

    helper.init(config.schema)
      .then(() => {
        new PgBoss(config).start()
          .then(boss => boss.stop())
          .then(() => helper.init(config.schema))
          .then(() => finished())
          .catch(error => {
            assert(false, error.message);
            finished();
          });
      });
  });

  it('should not allow a 51 character custom schema name', function(){

    let config = helper.getConfig();

    config.schema = 'thisisareallylongschemanamefortestingmaximumlengthb';

    assert.throws(function () {
      let boss = new PgBoss(config);
    });

  });

  it('should accept a connectionString property', function(finished){

    let connectionString = helper.getConnectionString();

    new PgBoss({connectionString}).start()
      .then(boss => boss.stop())
      .then(() => finished())
      .catch(error => {
        assert(false, error.message);
        finished();
      });
  });

  it('should accept a connectionString and schema properties', function(finished){
    const connectionString = 'postgresql://postgres@127.0.0.1:5432/db';
    const schema = 'pgboss_custom_schema';
    const boss = new PgBoss({connectionString, schema});

    assert.equal(boss.config.schema, schema);

    finished();
  });

  it('set pool config `poolSize`', function(finished){

    let boss;
    const poolSize = 14;

    helper.start({poolSize})
      .then(b => {
        boss = b;
        assert(boss.db.config.poolSize === poolSize);
        assert(boss.db.pool.options.max === poolSize);
      })
      .then(() => boss.stop())
      .then(() => finished());
  });

  it('set pool config `max`: `poolSize` === `max`', function(finished){

    let boss;
    const max = 13;

    helper.start({max})
      .then(b => {
        boss = b;
        assert(boss.db.config.max === boss.db.config.poolSize);
        assert(boss.db.config.max === max);
        assert(boss.db.config.poolSize === max);
        assert(boss.db.pool.options.max === max);
      })
      .then(() => boss.stop())
      .then(() => finished());
  });
});
