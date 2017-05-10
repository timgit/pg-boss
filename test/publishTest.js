const assert = require('chai').assert;
const helper = require('./testHelper');

describe('publish', function(){

  let boss;

  before(function(finished){
    this.timeout(3000);

    helper.start()
      .then(dabauce => {
        boss = dabauce;
        finished();
      });
  });

  after(function(finished){
    boss.stop().then(() => finished());
  });

  it('should fail with no arguments', function(finished) {
    boss.publish().catch(error => {
      assert(true);
      finished();
    });
  });

  it('should fail with a function for data', function(finished) {
    boss.publish('job', () => true).catch(error => {
      assert(true);
      finished();
    });
  });

  it('should fail with a function for options', function(finished) {
    boss.publish('job', 'data', () => true).catch(error => {
      assert(true);
      finished();
    });
  });

  it('should accept single string argument', function(finished) {
    const jobName = 'publishNameOnly';

    boss.subscribe(jobName, job => {
      job.done()
        .then(() => {
          assert(true);
          finished();
        });
    });

    boss.publish(jobName);
  });


  it('should accept job object argument with only name', function(finished){
    const jobName = 'publishJobNameOnly';

    boss.subscribe(jobName, job => {
      job.done().then(() => {
        assert(true);
        finished();
      });
    });

    boss.publish({name: jobName});
  });


  it('should accept job object with name and data only', function(finished){
    const jobName = 'publishJobNameAndData';
    const message = 'hi';

    boss.subscribe(jobName, job => {
      job.done().then(() => {
        assert.equal(message, job.data.message);
        finished();
      });
    });

    boss.publish({name: jobName, data: {message}});
  });


  it('should accept job object with name and options only', function(finished){
    const jobName = 'publishJobNameAndOptions';
    const options = {someCrazyOption:'whatever'};

    boss.subscribe(jobName, job => {
      job.done().then(() => {
        assert.isNull(job.data);
        finished();
      });
    });

    boss.publish({name: jobName, options});
  });

});



