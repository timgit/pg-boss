var assert = require('chai').assert;
var helper = require('./testHelper');

describe('archive', function() {

    var boss;
    var db;
    
    before(function(finished){
        helper.start({archiveCompletedJobsEvery:'1 second', archiveCheckInterval: 500})
            .then(dabauce => {
                boss = dabauce;
                db = helper.getDb();
                finished();
            });
    });

    after(function(finished) {
       boss.stop().then(() => finished()); 
    });
    
    it('should archive a job', function(finished){
        this.timeout(3000);

        var jobName = 'archiveMe';
        var jobId = null;

        boss.publish(jobName).then(id => {
            jobId = id;

            db.executeSql('select id from pgboss.job where id = $1', [jobId])
                .then(result => {
                    assert.equal(1, result.rows.length);
                });
        });

        boss.subscribe(jobName, (job, done) => {
            done().then(() => {
                setTimeout(() => {
                    db.executeSql('select id from pgboss.job where id = $1', [jobId])
                        .then(result => {
                            assert.equal(0, result.rows.length);
                            finished();
                        });
                }, 2000);
            });
        });

    });



});
