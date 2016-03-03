const pg = require('pg');

class Db {
  constructor(config){
    this.config = config;
  }

  executeSql(sql, params){
    if(params && !Array.isArray(params))
      params = [params];

    return new Promise((resolve, reject) => {
      pg.connect(this.config, (err, client, done) => {
        client.query(sql, params, (err, result) => {
          if(err)
            reject(err);
          else
            resolve(result);

          done();
        });
      });
    });

  }
}

module.exports = Db;
