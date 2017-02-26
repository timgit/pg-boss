var assert = require('chai').assert;
var helper = require('./testHelper');

describe('singleton', function() {

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

    beforeEach(function(finished){
        helper.empty().then(() => finished());
    });

    it('should not allow more than 1 pending job at a time with the same key', function(finished){

        var jobName = 'singleton';
        var singletonKey = 'a';

        boss.publish(jobName, null, {singletonKey})
            .then(jobId => {
                assert.isOk(jobId);
                return boss.publish(jobName, null, {singletonKey});
            })
            .then(jobId => {
                assert.isNotOk(jobId);
                finished();
            });

    });

    it('should not allow more than 1 complete job with the same key with an interval', function(finished){

        var jobName = 'singleton';
        var singletonKey = 'a';
        var singletonMinutes = 1;

        boss.publish(jobName, null, {singletonKey, singletonMinutes})
            .then(jobId => boss.fetch(jobName))
            .then(job => boss.complete(job.id))
            .then(() => boss.publish(jobName, null, {singletonKey, singletonMinutes}))
            .then(jobId => {
                assert.isNotOk(jobId);
                finished();
            });
    });

    it('should allow more than 1 pending job at the same time with different keys', function (finished) {

        var jobName = 'singleton';

        boss.publish(jobName, null, {singletonKey: 'a'})
            .then(jobId => {
                assert.isOk(jobId);
                return boss.publish(jobName, null, {singletonKey: 'b'});
            })
            .then(jobId => {
                assert.isOk(jobId);
                finished();
            });

    });
});
