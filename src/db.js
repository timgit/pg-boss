const pg = require('pg');
const Promise = require("bluebird");
const migrations = require('./migrations');

class Db {
    constructor(config){
        // prefers connection strings over objects
        this.config = config.connectionString || config;
        this.pool = new pg.Pool(this.config);
    }

    executePreparedSql(name, text, values){
        return this.execute({name,text,values});
    }

    executeSql(text, values){
       return this.execute({text,values});
    }

    execute(query) {
        if(query.values && !Array.isArray(query.values))
            query.values = [query.values];

        function deferred(resolve, reject) {
            this.pool.connect(function(err, client, done) {
                if(err) {
                    reject(err);
                    return done();
                }

                client.query(query, (err, result) => {
                    if(err)
                        reject(err);
                    else
                        resolve(result);

                    done();
                });

                done();
            });
        }

        return new Promise(deferred);
    }

    migrate(version, uninstall) {
        let migration = migrations.get(this.config.schema, version, uninstall);

        return Promise.each(migration.commands, command => this.executeSql(command))
            .then(() => migration.version);
    }
}

module.exports = Db;
