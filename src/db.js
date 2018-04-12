const EventEmitter = require('events');
const pg = require('pg');
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
      max: poolConfig.poolSize || poolConfig.max,
      ssl: !!poolConfig.ssl,
      Promise
    });

    this.pool.on('error', error => this.emit('error', error));

    function parseConnectionString(connectionString){
      const parseQuerystring = true;
      const params = url.parse(connectionString, parseQuerystring);
      const auth = params.auth.split(':');

      let parsed = {
        user: auth[0],
        host: params.hostname,
        port: params.port,
        database: params.pathname.split('/')[1],
        ssl: !!params.query.ssl
      };

      if(auth.length === 2)
        parsed.password = auth[1];

      return parsed;
    }

  }

  close(){
    return !this.pool.ending ? this.pool.end() : Promise.resolve(true);
  }

  executeSql(text, values) {
    return this.pool.query(text, values);
  }
}

module.exports = Db;
