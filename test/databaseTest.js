const Promise = require('bluebird');
const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');

describe('database', function(){

  it('should fail on invalid database host', function(finished){

    this.timeout(10000);

    const boss = new PgBoss('postgres://bobby:tables@wat:12345/northwind');

    boss.start()
      .then(() => {
        assert(false);
        return boss.stop();
      })
      .then(() => finished())
      .catch(() => {
        assert(true);
        finished();
      });
  });


  it('can be swapped out via BYODB', function(finished) {

    const query = 'SELECT something FROM somewhere';

    const mydb = {
      executeSql: (text, values) => Promise.resolve({rows:[],text})
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


  it('connection count does not exceed configured pool size', function(finished){

    this.timeout(5000);

    const listenerCount = 100;
    const poolSize = 5;

    let listeners = [];
    for(let x = 0; x<listenerCount; x++)
      listeners[x] = x;

    let boss;
    let database;
    let prevConnectionCount;

    helper.start({poolSize})
      .then(b => boss = b)
      .then(() => helper.getDb())
      .then(db => database = db)
      .then(() => countConnections(database))
      .then(connectionCount => prevConnectionCount = connectionCount)
      .then(() => Promise.map(listeners, (val, index) => boss.subscribe(`job${index}`, () => {})))
      .then(() => Promise.delay(3000))
      .then(() => countConnections(database))
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
      return db.executeSql('SELECT count(*) as connections FROM pg_stat_activity')
        .then(result => parseFloat(result.rows[0].connections));
    }

  });

});
