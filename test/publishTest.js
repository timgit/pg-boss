var assert = require('chai').assert;
var helper = require('./testHelper');

describe('publish', function(){

    var boss;

    before(function(finished){
        helper.start()
            .then(dabauce => {
                boss = dabauce;
                finished();
            });
    });

    it('should fail with no arguments', function() {
        assert.throws(() => boss.publish());
    });

    it('should accept single string argument', function(finished) {
        var jobName = 'publishNameOnly';

        boss.subscribe(jobName, (job, done) => {
            done().then(() => {
                assert(true);
                finished();
            });
        });

        boss.publish(jobName);
    });


    it('should accept job object argument with only name', function(finished){
        var jobName = 'publishJobNameOnly';

        boss.subscribe(jobName, (job, done) => {
            done().then(() => {
                assert(true);
                finished();
            });
        });

        boss.publish({name: jobName});
    });

    
    it('should accept job object with name and data only', function(finished){
        var jobName = 'publishJobNameAndData';
        var message = 'hi';

        boss.subscribe(jobName, (job, done) => {
            done().then(() => {
                assert.equal(message, job.data.message);
                finished();
            });
        });

        boss.publish({name: jobName, data: {message}});
    });


    it('should accept job object with name and options only', function(finished){
        var jobName = 'publishJobNameAndOptions';
        var options = {someCrazyOption:'whatever'};

        boss.subscribe(jobName, (job, done) => {
            done().then(() => {
                assert.isNull(job.data);
                finished();
            });
        });

        boss.publish({name: jobName, options});
    });

});



