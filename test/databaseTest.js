const Promise = require('bluebird');
const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');

describe('database', function(){

  this.timeout(15000);

  it('should fail on invalid database host', function(finished){

    const boss = new PgBoss('postgres://bobby:tables@wat:12345/northwind');

    boss.start()
      .then(() => {
        assert(false);
        return boss.stop();
      })
      .then(() => finished())
      .catch(() => finished());
  });


  it('should work with a custom schema name', function(finished){

    const jobName = 'custom-schema';

    let config = helper.getConfig();
    config.schema = '_queue';

    let boss, jobId;

    helper.start(config)
      .then(result => boss = result)
      .then(() => boss.publish(jobName))
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(job => {
        assert(job.id === jobId);
        finished();
      })
      .catch(error => {
          assert(false, error.message);
          finished();
      });

  });

  it('can be swapped out via BYODB', function(finished) {

    const query = 'SELECT something FROM somewhere';

    const mydb = {
      executeSql: (text, values) => Promise.resolve({rows:[], text, rowCount: 0})
    };

    const boss = new PgBoss({db:mydb});

    boss.start()
      .then(() => boss.db.executeSql(query))
      .then(response => assert(response.text === query))
      .then(() => boss.stop())
      .then(() => finished())
      .catch(err => {
        console.error(err.message);
        finished();
      });

  });


  it('connection count does not exceed configured pool size with `poolSize`', function(finished){

    const listenerCount = 100;
    const poolSize = 5;

    let listeners = [];
    for(let x = 0; x<listenerCount; x++)
      listeners[x] = x;

    let boss;
    let prevConnectionCount;

    helper.start({poolSize})
      .then(b => boss = b)
      .then(() => boss.db)
      .then(() => countConnections(boss.db))
      .then(connectionCount => prevConnectionCount = connectionCount)
      .then(() => Promise.map(listeners, (val, index) => boss.subscribe(`job${index}`, () => {})))
      .then(() => Promise.delay(3000))
      .then(() => countConnections(boss.db))
      .then(connectionCount => {
        let newConnections = connectionCount - prevConnectionCount;
        console.log(`listeners: ${listenerCount}  pool size: ${poolSize}`);
        console.log('connections:');
        console.log(`  before subscribing: ${prevConnectionCount}  now: ${connectionCount}  new: ${newConnections}`);
        assert(newConnections <= poolSize);
      })
      .then(() => boss.stop())
      .then(() => finished());


    function countConnections(db) {
      return db.executeSql('SELECT count(*) as connections FROM pg_stat_activity WHERE application_name=$1',
        [boss.db.config.application_name])
        .then(result => parseFloat(result.rows[0].connections));
    }

  });

  it('connection count does not exceed configured pool size with `max`', function(finished){

    const listenerCount = 100;
    const max = 5;

    let listeners = [];
    for(let x = 0; x<listenerCount; x++)
      listeners[x] = x;

    let boss;
    let prevConnectionCount;

    helper.start({max})
      .then(b => boss = b)
      .then(() => boss.db)
      .then(() => countConnections(boss.db))
      .then(connectionCount => prevConnectionCount = connectionCount)
      .then(() => Promise.map(listeners, (val, index) => boss.subscribe(`job${index}`, () => {})))
      .then(() => Promise.delay(3000))
      .then(() => countConnections(boss.db))
      .then(connectionCount => {
        let newConnections = connectionCount - prevConnectionCount;
        console.log(`listeners: ${listenerCount}  pool size: ${max}`);
        console.log('connections:');
        console.log(`  before subscribing: ${prevConnectionCount}  now: ${connectionCount}  new: ${newConnections}`);
        assert(newConnections <= max);
      })
      .then(() => boss.stop())
      .then(() => finished());


    function countConnections(db) {
      return db.executeSql('SELECT count(*) as connections FROM pg_stat_activity WHERE application_name=$1',
        [boss.db.config.application_name])
        .then(result => parseFloat(result.rows[0].connections));
    }

  });

});
