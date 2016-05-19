const assert = require('assert');
const EventEmitter = require('events').EventEmitter; //node 0.10 compatibility
const Db = require('./db');
const plans = require('./plans');
const migrations = require('./migrations');
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
        let migration = migrations.get(schema, version, uninstall);
        assert(migration, 'migration not found for this version');
        return migration.commands.join(';\n\n');
    }

    start(){
        this.isInstalled()
            .then(installed => {
                if(!installed) {
                    this.create()
                        .then(() => this.emit('go'))
                        .catch(error => this.emit('error', error));
                } else {
                    this.version()
                        .then(version => {
                            if (schemaVersion !== version) {
                                this.update(version)
                                    .then(() => this.emit('go'));
                            } else {
                                this.emit('go');
                            }
                        });
                }
            });
    }

    update(current) {
        // temp workaround for bad 0.0.2 schema update 
        if(current == '0.0.2')
            current = '0.0.1';

        return this.db.migrate(current)
            .then(version => {
                if(version !== schemaVersion)
                    return this.update(version);
            });
    }
    
    create(){
        return Promise.each(plans.createAll(this.config.schema), command => this.db.executeSql(command))
            .then(() => this.db.executeSql(plans.insertVersion(this.config.schema), schemaVersion));
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
