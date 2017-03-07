const pg = require('pg');
const Promise = require("bluebird");
const migrations = require('./migrations');
const url = require('url');

class Db {
    constructor(config){

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
            max: poolConfig.poolSize
        });


        function parseConnectionString(connectionString){
            const params = url.parse(connectionString);
            const auth = params.auth.split(':');

            return {
                user: auth[0],
                password: auth[1],
                host: params.hostname,
                port: params.port,
                database: params.pathname.split('/')[1]
            };
        }
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

        return new Promise((resolve, reject) => {
            this.pool.connect((err, client, done) => {

                if(err)
                    return reject(err);

                client.query(query, (err, result) => {
                    done(err);

                    if(err)
                        reject(err);
                    else
                        resolve(result);
                });
            });
        });

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
