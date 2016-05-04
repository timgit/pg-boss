const assert = require('assert');
const EventEmitter = require('events').EventEmitter; //node 0.10 compatibility
const Db = require('./db');
const plans = require('./plans');
const schemaVersion = require('../version.json').schema;
const Promise = require("bluebird");

class Contractor extends EventEmitter {
    constructor(config){
        super();
        this.config = config;
        this.db = new Db(config);
    }

    version() {
        return this.db.executeSql(plans.getVersion(this.config.schema))
            .then(result => result.rows.length ? result.rows[0].version : null)
            .catch(error => {
                this.emit('error', error);
                return null;
            });
    }

    isCurrent(){
        return this.version().then(version => version === schemaVersion);
    }

    isInstalled() {
        return this.db.executeSql(plans.versionTableExists(this.config.schema))
            .then(result => result.rows.length ? result.rows[0].name : null);
    }

    static constructionPlans(schema){
        let exportPlans = plans.createAll(schema);
        exportPlans.push(plans.insertVersion(schema).replace('$1', schemaVersion));

        return exportPlans.join(';\n\n');
    }

    static migrationPlans(schema, version, uninstall){
        let migration = plans.getMigration(schema, version, uninstall);
        assert(migration, 'migration not found for this version');
        return migration.commands.join(';\n\n');
    }

    start(){
        let config = this.config;
        let db = this.db;
        let self = this;

        this.isInstalled()
            .then(installed => {
                if(!installed)
                    return create();

                self.version()
                    .then(version => {
                        if(schemaVersion === version)
                            return this.emit('go');

                        migrate(version);
                    });
            });

        function migrate(version) {
            if(version == '0.0.2')
                version = '0.0.1';

            let migration = plans.getMigration(config.schema, version);

            Promise.each(migration.commands, command => db.executeSql(command))
                .then(() => {
                    if(migration.version === schemaVersion)
                        self.emit('go');
                    else
                        migrate(migration.version);                
                })
                .catch(error => self.emit('error', error));
        }
        
        function create(){
            Promise.each(plans.createAll(config.schema), command => db.executeSql(command))
                .then(() => db.executeSql(plans.insertVersion(config.schema), schemaVersion))
                .then(() => self.emit('go'))
                .catch(error => self.emit('error', error));
        }
    }

    connect(){
        let connectErrorMessage = 'this version of pg-boss does not appear to be installed in your database. I can create it for you via start().';

        this.isInstalled()
            .then(installed => {
                if(!installed)
                    return this.emit('error', connectErrorMessage);

                this.isCurrent()
                    .then(current => {
                        if(current)
                            this.emit('go');
                        else
                            this.emit('error', connectErrorMessage);
                    });
            });
    }
}

module.exports = Contractor;
