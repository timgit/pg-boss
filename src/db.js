const EventEmitter = require('events');
const pg = require('pg');
const Promise = require("bluebird");
const migrations = require('./migrations');
const url = require('url');

class Db extends EventEmitter {
  constructor(config){
    super();

    this.config = config;

    let poolConfig = (config.connectionString)
      ? parseConnectionString(config.connectionString)
      : config;

    this.pool = new pg.Pool({
      user: poolConfig.user,
      password: poolConfig.password,
      host: poolConfig.host,
      port: poolConfig.port,
      database: poolConfig.database,
      application_name: poolConfig.application_name || 'pgboss',
      max: poolConfig.poolSize,
      ssl: !!poolConfig.ssl,
      Promise
    });

    this.pool.on('error', error => this.emit('error', error));

    function parseConnectionString(connectionString){
      const params = url.parse(connectionString);
      const auth = params.auth.split(':');

      return {
        user: auth[0],
        password: auth[1],
        host: params.hostname,
        port: params.port,
        database: params.pathname.split('/')[1]
      };
    }
  }

  close(){
    return this.pool.end();
  }

  executeSql(text, values) {
    if(values && !Array.isArray(values))
      values = [values];

    return this.pool.query(text, values);
  }

  migrate(version, uninstall) {
    let migration = migrations.get(this.config.schema, version, uninstall);

    if(!migration){
      let errorMessage = `Migration to version ${version} failed because it could not be found.  Your database may have been upgraded by a newer version of pg-boss`;
      return Promise.reject(new Error(errorMessage));
    }

    return Promise.each(migration.commands, command => this.executeSql(command))
      .then(() => migration.version);
  }
}

module.exports = Db;
