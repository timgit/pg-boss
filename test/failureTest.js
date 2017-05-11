const assert = require('chai').assert;
const helper = require('./testHelper');

describe('error', function(){

  let boss;

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

  it('should reject missing id argument', function(finished){
    boss.fail().catch(() => finished());
  });

  it('should fail a job when requested', function(finished){
    this.timeout(3000);

    const jobName = 'will-fail';

    boss.publish(jobName)
      .then(id => boss.fetch(jobName))
      .then(job => boss.fail(job.id))
      .then(() => {
        assert(true);
        finished();
      });

  });

  it('should fail a job from a subscriber callback', function(finished) {

    this.timeout(3000);

    const errorMessage = 'something went wrong';
    const jobName = 'suspect-job';
    let jobId;


    boss.publish(jobName)
      .then(id => jobId = id);

    boss.on('failed', failure => {
      assert.equal(failure.job.id, jobId);
      assert.equal(errorMessage, failure.error.message);
      finished();
    });

    boss.subscribe(jobName, job => {
      let myError = new Error(errorMessage);

      job.done(myError)
        .catch(error => {
          console.error(error);
          assert(false, error.message);
        });

    });

  });

  it('should subscribe to a job failure', function(finished){

    this.timeout(3000);

    const jobName = 'subscribe-fail';
    let jobId;

    boss.onFail(jobName, job => {
      assert.strictEqual(jobId, job.data.request.id);
      finished();
    });

    boss.publish(jobName)
      .then(id => jobId = id)
      .then(() => boss.fetch(jobName))
      .then(job => boss.fail(job.id));

  });

});



