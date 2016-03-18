const pg = require('pg');

class Db {
    constructor(config){
        // prefers connection strings over objects
        this.config = config.connectionString || config;
    }

    executeSql(sql, params){
        if(params && !Array.isArray(params))
            params = [params];

        var config = this.config;

        return new Promise(deferred);


        function deferred(resolve, reject) {

            pg.connect(config, (err, client, done) => {
                if(err) {
                    reject(err);
                    return done();
                }

                client.query(sql, params, (err, result) => {
                    if(err)
                        reject(err);
                    else
                        resolve(result);

                    done();
                });
            });

        }

  }
}

module.exports = Db;
