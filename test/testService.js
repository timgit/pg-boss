var Db = require('../lib/db');
var config = require('./config.json');

module.exports = {
  init: init
};

function init() {
    var schema = config.schema || 'pgboss';
    var emptyJobsCommand = 'truncate table ' + schema + '.job';

    var db = new Db(config);

    return db.executeSql(emptyJobsCommand)
        .catch(error => console.error(error));
}