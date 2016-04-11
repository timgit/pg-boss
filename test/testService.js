const Db = require('../lib/db');
const config = require('./config.json');

module.exports = {
  init: init
};

function init() {
    const schema = config.schema || 'pgboss';
    const emptyJobsCommand = `truncate table ${schema}.job`;

    var db = new Db(config);

    return db.executeSql(emptyJobsCommand)
        .catch(error => console.error(error));
}