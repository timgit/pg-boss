const Db = require('./db');

const archiveCommand = `
  DELETE pdq.job
  WHERE state = 'completed'
    AND completedOn + INTERVAL '1 day' < now()
`;

class Boss {
  constructor(config){
    this.config = config;
    this.superviseInterval = 1000 * 60 * 60;
  }

  supervise(){
    setImmediate(archive);
    setInterval(archive, this.superviseInterval);

    function archive(){
      let db = new Db(this.config);
      return db.executeSql(archiveCommand);
    }
  }
}

module.exports = Boss;
