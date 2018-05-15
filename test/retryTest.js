const assert = require('chai').assert;
const helper = require('./testHelper');

describe('retries', function() {

  this.timeout(10000);

  describe('when a job didn\'t complete', function() {
    let boss;
  
    before(function(finished){
      helper.start({expireCheckInterval:200, newJobCheckInterval: 200})
        .then(dabauce => {
          boss = dabauce;
          finished();
        });
    });
  
    after(function(finished){
      boss.stop().then(() => finished());
    });
  
    it('should retry a job that exceeded its given expiration time', function (finished) {
      const expireIn = '100 milliseconds';
      const retryLimit = 1;
  
      let subscribeCount = 0;
  
      // don't call job.done() so it will expire
      boss.subscribe('unreliable', job => subscribeCount++);
  
      boss.publish({name: 'unreliable', options: {expireIn, retryLimit}});
  
      setTimeout(function() {
        assert.equal(subscribeCount, retryLimit + 1);
        finished();
  
      }, 3000);
    });
  });

  describe('when failedCheckInterval is specified', function() {
    let boss;

    before(function(finished){
      helper.start({
        newJobCheckInterval: 200,
        failedCheckInterval: 200
      })
        .then(dabauce => {
          boss = dabauce;
          finished();
        });
    });

    after(function(finished){
      boss.stop().then(() => finished());
    });

    it('should retry a job that failed', function (finished) {
      const retryLimit = 1;
      const expectedJobRunCount = retryLimit + 1;
      let jobRunCount = 0;
  
      boss.subscribe('failure-job', job => {
        jobRunCount++
        job.done(new Error('something went wrong'));
      });
      
      boss.publish({name: 'failure-job', options: {retryLimit}});
  
      setTimeout(function() {
        assert.equal(jobRunCount, expectedJobRunCount);
        finished();
      }, 3000);
    });
  });

  describe('when failedCheckInterval is not specified', function() {
    let boss;

    before(function(finished){
      helper.start({
        newJobCheckInterval: 200
      })
        .then(dabauce => {
          boss = dabauce;
          finished();
        });
    });

    after(function(finished){
      boss.stop().then(() => finished());
    });

    it('should not retry a job that failed', function (finished) {
      const retryLimit = 1;
      const expectedJobRunCount = 1;
      let jobRunCount = 0;
  
      boss.subscribe('failure-job', job => {
        jobRunCount++
        job.done(new Error('something went wrong'));
      });
      
      boss.publish({name: 'failure-job', options: {retryLimit}});
  
      setTimeout(function() {
        assert.equal(jobRunCount, expectedJobRunCount);
        finished();
      }, 3000);
    });
  });
});
