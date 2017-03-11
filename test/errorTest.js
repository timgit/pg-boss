const assert = require('chai').assert;
const helper = require('./testHelper');

describe('error', function(){

    let boss;

    before(function(finished){
        helper.start()
            .then(dabauce => {
                boss = dabauce;
                boss.on('error', console.error);
                finished();
            });
    });

    after(function(finished){
        boss.stop().then(() => finished());
    });

    it('should handle an error in a subscriber and not blow up', function(finished) {

        this.timeout(3000);

        let subscribeCount = 0;

        publish()
            .then(publish)
            .then(() => {
                boss.subscribe('cray', function(job, done) {

                    subscribeCount++;

                    if(subscribeCount === 1)
                        throw new Error('test - nothing to see here');
                    else {
                        done().then(() => {
                            assert(true);
                            finished();
                        });
                    }

                });
        });

        function publish(){
            return boss.publish('cray', {message: 'volatile'})
                .then(jobId => console.log(`job submitted: ${jobId}`));
        }

    });
});



