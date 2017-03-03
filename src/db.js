const pg = require('pg');
const Promise = require("bluebird");
const migrations = require('./migrations');

class Db {
    constructor(config){
        // prefers connection strings over objects
        this.config = config.connectionString || config;
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

        let config = this.config;

        return new Promise(deferred);


        function deferred(resolve, reject) {

            pg.connect(config, (err, client, done) => {
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
            });
        }
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
