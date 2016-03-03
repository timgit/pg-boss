const EventEmitter = require('events');
const assert = require('assert');
const Contractor = require('./contractor');
const Worker = require('./worker');
const Manager = require('./manager');
const Boss = require('./boss');

class PgBoss extends EventEmitter {
    constructor(config){
      assert(config && (typeof config == 'object' || typeof config == 'string'),
        'string or config object is required to connect to postgres');

      if(typeof config == 'object'){
        assert(config.database && config.user && 'password' in config,
          'expected configuration object to have enough information to connect to PostgreSQL');

        config.host = config.host || 'localhost';
        config.port = config.port || 5432;
      }

      this.config = config;

      // contractor makes sure we have a happy database home for work
      Contractor.checkEnvironment(config)
        .then(() => {

          // boss keeps the books and archives old jobs
          var boss = new Boss(config);
          boss.supervise();

          // manager makes sure workers aren't taking too long to finish their jobs
          var manager = new Manager(config);
          manager.monitor();

          this.worker = new Worker(config);
          this.worker.clockIn();
          this.worker.on('job', name => this.emit('job', name));

          this.emit('ready');
        })
        .catch(error => this.emit('error', error));

    }

    registerJob(name, callback){
      this.worker.registerJob(name, callback);
    }

    submitJob(name, data, config){
      this.worker.submitJob(name, data, config);
    }
}

module.exports = PgBoss;
