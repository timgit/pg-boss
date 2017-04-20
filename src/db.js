const EventEmitter = require('events');
const pg = require('pg');
const Promise = require("bluebird");
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
      const parseQuerystring = true;
      const params = url.parse(connectionString, parseQuerystring);
      const auth = params.auth.split(':');

      return {
        user: auth[0],
        password: auth[1],
        host: params.hostname,
        port: params.port,
        database: params.pathname.split('/')[1],
        ssl: !!params.query.ssl
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
}

module.exports = Db;
