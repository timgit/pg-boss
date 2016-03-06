const Db = require('./db');
const pkg = require('./package.json');

const command = `
  CREATE SCHEMA IF NOT EXISTS pdq;

  CREATE TABLE IF NOT EXISTS pdq.job (
    id uuid primary key not null,
    name text not null,
    data jsonb,
    state text not null,
    retryLimit integer not null default(0),
    retryCount integer not null default(0),
    startAfter timestamp without time zone,
    expireAfter interval,
    startedOn timestamp without time zone,
    createdOn timestamp without time zone not null,
    completedOn timestamp without time zone
  );

  CREATE TABLE IF NOT EXISTS pdq.version (version text primary key);

  INSERT INTO pdq.version(version) VALUES ($1) ON CONFLICT DO NOTHING;
`;

class Contractor {
  static checkEnvironment(config){
    let db = new Db(config);
    return db.executeSql(command, pkg.version);
  }
}

module.exports = Contractor;
