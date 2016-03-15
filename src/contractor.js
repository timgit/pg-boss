const EventEmitter = require('events');
const Db = require('./db');
const pkg = require('../package.json');


class Contractor extends EventEmitter {
    constructor(config){
        super();

        this.config = config;
    }

    checkEnvironment(){
        let db = new Db(this.config);

        return createSchema()
            .then(createJobTable)
            .then(createVersionTable)
            .then(insertVersion)
            .catch(error => this.emit('error', error));


        function createSchema() {
            const schemaCreateCommand =
              'CREATE SCHEMA IF NOT EXISTS pgboss';

            return db.executeSql(schemaCreateCommand);
        }

        function createJobTable() {
            const jobTableCreateCommand = `
                CREATE TABLE IF NOT EXISTS pgboss.job (
                    id uuid primary key not null,
                    name text not null,
                    data jsonb,
                    state text not null,
                    retryLimit integer not null default(0),
                    retryCount integer not null default(0),
                    startIn interval,
                    startedOn timestamp without time zone,
                    expireIn interval,
                    expiredOn timestamp without time zone,
                    createdOn timestamp without time zone not null default now(),
                    completedOn timestamp without time zone
                )`;

            return db.executeSql(jobTableCreateCommand);
        }

        function createVersionTable() {
            const versionTableCreateCommand =
                'CREATE TABLE IF NOT EXISTS pgboss.version (version text primary key)';

            return db.executeSql(versionTableCreateCommand);
        }

        function insertVersion() {
            const versionInsertCommand =
                `INSERT INTO pgboss.version(version) VALUES ($1) ON CONFLICT DO NOTHING;`;

            return db.executeSql(versionInsertCommand, pkg.version);
        }

    }

}

module.exports = Contractor;
