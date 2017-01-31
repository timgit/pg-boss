var assert = require('chai').assert;
var helper = require('./testHelper');

describe('fetch', function(){

    var boss;

    before(function(finished){
        helper.start()
            .then(dabauce => {
                boss = dabauce;
                finished();
            });
    });

    after(function(finished){
        boss.stop().then(() => finished());
    });

    it('should fetch a single job by name and manually complete', function(finished) {
        var jobName = 'no-subscribe-required';

        boss.publish(jobName)
            .then(() => boss.fetch(jobName))
            .then(job => {
                assert(jobName === job.name);
                return boss.complete(job.id);
            })
            .then(() => {
                assert(true);
                finished();
            });
    });

});



