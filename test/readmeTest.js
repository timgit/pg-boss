const assert = require('chai').assert;
const PgBoss = require('../src/index');
const helper = require('./testHelper');

describe('examples', function(){

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
            .then(jobId => console.log(`sent job ${jobId}`))
            .catch(onError);

          boss.subscribe('some-job', (job, done) => {
            console.log(`received job ${job.name} (${job.id})`);
            console.log(JSON.stringify(job.data));

            done()
              .then(() => {
                console.log(`job ${job.id} confirmed done`);
                assert.equal('some-job', job.name); // exclude test code
                assert.equal('parameter1', job.data.param1); // exclude test code
                finished();   // exclude test code
              })
              .catch(onError);
          });
        }

        function onError(error) {
          console.error(error);
        }
        // example end
    });
});
