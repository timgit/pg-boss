const Db = require('./db');

const timeoutCommand = `
  UPDATE pdq.job
  SET state = 'timeout'
  WHERE state = 'active'
    AND (startedOn + expireAfter) > now()
`;

class Manager {
  constructor(config){
    this.config = config;
    this.monitorInterval = 1000 * 60;
  }

  monitor(){
    setImmediate(timeoutOldJobs);
    setInterval(timeoutOldJobs, this.monitorInterval);

    function timeoutOldJobs(){
      let db = new Db(this.config);
      return db.executeSql(timeoutCommand);
    }
  }
}

module.exports = Manager;