const assert = require('chai').assert;
const helper = require('./testHelper');

describe('publish', function(){

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

  it('should fail with no arguments', function(finished) {
    boss.publish()
      .catch(error => finished());
  });

  it('should fail with a function for data', function(finished) {
    boss.publish('job', () => true)
      .catch(error => finished());
  });

  it('should fail with a function for options', function(finished) {
    boss.publish('job', 'data', () => true)
      .catch(error => finished());
  });

  it('should accept single string argument', function(finished) {
    const jobName = 'publishNameOnly';

    boss.publish(jobName)
      .then(() => boss.fetch(jobName))
      .then(job => boss.complete(job.id))
      .then(() => finished());

  });

  it('should accept job object argument with only name', function(finished){
    const jobName = 'publishJobNameOnly';

    boss.publish({name: jobName})
      .then(() => boss.fetch(jobName))
      .then(job => boss.complete(job.id))
      .then(() => finished());
  });


  it('should accept job object with name and data only', function(finished){
    const jobName = 'publishJobNameAndData';
    const message = 'hi';

    boss.publish({name: jobName, data: {message}})
      .then(() => boss.fetch(jobName))
      .then(job => {
        assert.equal(message, job.data.message);
        return boss.complete(job.id);
      })
      .then(() => finished());

  });


  it('should accept job object with name and options only', function(finished){
    const jobName = 'publishJobNameAndOptions';
    const options = {someCrazyOption:'whatever'};

    boss.publish({name: jobName, options})
      .then(() => boss.fetch(jobName))
      .then(job => {
        assert.isNull(job.data);
        return boss.complete(job.id);
      })
      .then(() => finished());

  });

  // it('should accept an array of jobs', function(finished){
  //   const name = 'publish-array';
  //
  //   boss.publish([{name},{name},{name},{name},{name}])
  //     .then()
  // });

});



