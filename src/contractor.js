const EventEmitter = require('events');
const Db = require('./db');
const plans = require('./plans');
const pkg = require('../package.json');

class Contractor extends EventEmitter {
    constructor(config){
        super();
        this.config = config;
    }

    start(){
        var config = this.config;

        let db = new Db(config);

        createSchema()
            .then(createVersionTable)
            .then(createJobTable)
            .then(setVersion)
            .then(() => this.emit('go'))
            .catch(error => this.emit('error', error));


        function createSchema() {
            return db.executeSql(plans.createSchema(config.schema));
        }

        function createJobTable() {
            return db.executeSql(plans.createJobTable(config.schema));
        }

        function createVersionTable() {
            return db.executeSql(plans.createVersionTable(config.schema));
        }

        function setVersion() {
            return db.executeSql(plans.setVersion(config.schema), pkg.version);
        }
    }

    connect(){
        let db = new Db(this.config);
        let jobTableExistsCommand = plans.jobTableExists(this.config.schema);

        return db.executeSql(jobTableExistsCommand)
            .then(result => {
                var tableName = result.rows[0].name;

                if(tableName)
                    this.emit('go');
                else
                    this.emit('error', 'job table not found in your database. I can create it for you via start().')
            })
            .catch(error => {
                this.emit('error', error);
                throw error;
            });
    }
}

module.exports = Contractor;
