const assert = require('chai').assert;
const helper = require('./testHelper');

describe('cancel', function() {

  this.timeout(10000);

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
    boss.cancel().catch(() => finished());
  });

  it('should cancel a pending job', function(finished){

    boss.subscribe('will_cancel', () => {
      assert(false, "job was cancelled, but still worked");
      finished();
    });

    let jobId;

    boss.publish('will_cancel', null, {startAfter: 1})
      .then(id => jobId = id)
      .then(() => boss.cancel(jobId))
      .then(() => helper.getJobById(jobId))
      .then(job => assert(job && job.state === 'cancelled'))
      .then(() => finished());

  });

  it('should not cancel a completed job', function(finished){

    boss.subscribe('will_not_cancel', job => {
        job.done()
          .then(() => boss.cancel(job.id))
          .then(response => {
            assert.strictEqual(response.updated,0);
            finished();
          });
      }
    );

    boss.publish('will_not_cancel');
  });

  it('should cancel a batch of jobs', function(finished){
    const jobName = 'cancel-batch';

    Promise.all([
      boss.publish(jobName),
      boss.publish(jobName),
      boss.publish(jobName)
    ])
    .then(jobs => boss.cancel(jobs))
    .then(() => finished());

  });

});
