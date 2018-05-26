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

    const someQueue = 'some-queue';

    boss.on('error', onError);

    boss.start()
      .then(ready)
      .catch(onError);

    function ready() {
      boss.publish(someQueue, {param1: 'parameter1'})
        .then(jobId => {
          console.log(`created job in queue ${someQueue}: ${jobId}`);
          _jobId = jobId;
        });
    
      boss.subscribe(someQueue, job => someAsyncJobHandler(job))
        .then(() => console.log(`subscribed to queue ${someQueue}`));

      boss.onComplete(someQueue, job => {
        console.log(`job ${job.id} completed`);
        assert.strictEqual(job.data.request.id, _jobId); // exclude test code
        finished();   // exclude test code
      });

    }

    function someAsyncJobHandler(job) {
      console.log(`received ${job.name} ${job.id}`);
      console.log(`data: ${JSON.stringify(job.data)}`);
    
      return Promise.resolve('got it');
    }

    function onError(error) {
      console.error(error);
    }
    // example end
  });
});
