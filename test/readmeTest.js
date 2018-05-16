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

    // example start
    const boss = new PgBoss(connectionString);

    _boss = boss; // exclude test code

    boss.on('error', onError);

    boss.start()
      .then(ready)
      .catch(onError);

    function ready() {
      boss.publish('some-job', {param1: 'parameter1'})
        .then(jobId => console.log(`created some-job ${jobId}`))
        .catch(onError);

      boss.subscribe('some-job', someJobHandler)
        .then(() => console.log('subscribed to some-job'))
        .catch(onError);
    }

    function someJobHandler(job) {
      console.log(`received ${job.name} ${job.id}`);
      console.log(`data: ${JSON.stringify(job.data)}`);

      job.done()
        .then(() => {
          console.log(`some-job ${job.id} completed`);
          assert.equal('some-job', job.name); // exclude test code
          assert.equal('parameter1', job.data.param1); // exclude test code
          finished();   // exclude test code
        })
        .catch(onError);
    }

    function onError(error) {
      console.error(error);
    }
    // example end
  });
});
