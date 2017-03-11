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

        boss.on('error', error => console.error(error));

        boss.start()
            .then(ready)
            .catch(error => console.error(error));
        
        function ready() {
            boss.publish('work', {message: 'stuff'})
                .then(jobId => console.log(`sent job ${jobId}`));

            boss.subscribe('work', (job, done) => {
                console.log(`received job ${job.name} (${job.id})`);
                console.log(JSON.stringify(job.data));

                done().then(() => {
                    console.log('Confirmed done');
                    assert.equal('work', job.name); // exclude test code
                    assert.equal('stuff', job.data.message); // exclude test code
                    finished();   // exclude test code
                });
            });
        }
        // example end
    });
});
