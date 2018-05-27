const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');

describe('examples', function(){

  this.timeout(10000);

  let _boss;

  after(function(finished){
    _boss.stop().then(() => finished());
  });

  it('readme example is totes valid', function(finished){
    const connectionString = helper.getConnectionString();

    let _jobId;

    // example start
    const boss = new PgBoss(connectionString);

    _boss = boss; // exclude test code

    boss.on('error', error => console.error(error));

    boss.start()
      .then(ready)
      .catch(error => console.error(error));

    function ready() {
      const someQueue = 'some-queue';

      boss.publish(someQueue, {param1: 'parameter1'})
        .then(jobId => {
          console.log(`created job in queue ${someQueue}: ${jobId}`);
          _jobId = jobId;
        });
    
      boss.subscribe(someQueue, job => someAsyncJobHandler(job))
        .then(() => console.log(`subscribed to queue ${someQueue}`));

      boss.onComplete(someQueue, job => {
        console.log(`job ${job.data.request.id} completed`);
        console.log(` - in state ${job.data.state}`);
        console.log(` - responded with '${job.data.response.value}'`);
        assert.strictEqual(job.data.request.id, _jobId); // exclude test code
        finished();   // exclude test code
      })
        .then(() => console.log(`subscribed to queue ${someQueue} completions`));

    }

    function someAsyncJobHandler(job) {
      console.log(`job ${job.id} received`);
      console.log(` - with data: ${JSON.stringify(job.data)}`);
    
      return Promise.resolve('got it');
    }
    // example end
  });
});
