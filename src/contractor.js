const EventEmitter = require('events');
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
        this.version().then(version => version === schemaVersion);
    }

    isInstalled() {
        return this.db.executeSql(plans.versionTableExists(this.config.schema))
            .then(result => result.rows.length ? result.rows[0].name : null);
    }

    constructionPlans(){
        var commands = [
            plans.createSchema(this.config.schema),
            plans.createJobTable(this.config.schema),
            plans.createVersionTable(this.config.schema),
            plans.insertVersion(this.config.schema)
        ];

        return commands.join(';\n\n');
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

            let migration = plans.getMigration(self.config.schema, version);

            Promise.each(migration.commands.map(command => db.executeSql(command)))
                .then(() => {
                    if(migration == schemaVersion)
                        self.emit('go');
                    else
                        migrate(migration.version);                
                })
                .catch(error => self.emit('error', error));
        }
        
        function create(){
            //TODO migrate to .each() from array
            db.executeSql(plans.createSchema(config.schema))
                .then(() => db.executeSql(plans.createJobTable(config.schema)))
                .then(() => db.executeSql(plans.createVersionTable(config.schema)))
                .then(() => db.executeSql(plans.insertVersion(config.schema), schemaVersion))
                .then(() => this.emit('go'))
                .catch(error => this.emit('error', error));
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
