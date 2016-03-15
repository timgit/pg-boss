const EventEmitter = require('events');
const Db = require('./db');

const archiveCommand = `
  DELETE FROM pgboss.job
  WHERE state = 'completed'
    AND completedOn + INTERVAL '1 day' < now()
`;

class Boss extends EventEmitter{
  constructor(config){
      super();

    this.config = config;
    this.superviseInterval = 1000 * 60 * 60;
  }

  supervise(){
      var self = this;

    setImmediate(archive);
    setInterval(archive, self.superviseInterval);

    function archive(){
      let db = new Db(self.config);

      return db.executeSql(archiveCommand)
          .catch(error => self.emit('error', error));;
    }
  }
}

module.exports = Boss;
