const assert = require('chai').assert;
const helper = require('./testHelper');
const Promise = require('bluebird');

describe('delayed jobs', function(){

  this.timeout(10000);

  let boss;

  before(async () => { boss = await helper.start() })
  after(() => boss.stop())

  it('should wait until after an int (in seconds)', function(finished) {

    let delaySeconds = 2;

    boss.subscribe('wait', job => {
      let start = new Date(job.data.submitted);
      let end = new Date();

      let elapsedSeconds = Math.floor((end-start)/1000);

      job.done()
        .then(() => {
          assert.isAtLeast(delaySeconds, elapsedSeconds);
          finished();
        });
    });

    boss.publish('wait', {message: 'hold your horses', submitted: Date.now()}, {startAfter: delaySeconds});

  });

  it('should wait until after a date time string', function(finished) {

    const queue = 'delay-date-string';

    let date = new Date();
    date.setUTCSeconds(date.getUTCSeconds() + 2);

    const startAfter = date.toISOString();
    const started = Date.now();

    boss.publish(queue, null, {startAfter})
      .then(() => boss.fetch(queue))
      .then(job => assert.strictEqual(job, null))
      .then(() => Promise.delay(2000))
      .then(() => boss.fetch(queue))
      .then(job => {
        assert.isOk(job);
        finished();
      });

  });

  it('should wait until after a date object', function(finished) {

    const queue = 'delay-date-object';

    let date = new Date();
    date.setUTCSeconds(date.getUTCSeconds() + 2);

    const startAfter = date;
    const started = Date.now();

    boss.publish(queue, null, {startAfter})
      .then(() => boss.fetch(queue))
      .then(job => assert.strictEqual(job, null))
      .then(() => Promise.delay(2000))
      .then(() => boss.fetch(queue))
      .then(job => {
        assert.isOk(job);
        finished();
      });

  });

  it('should work with publishAfter() and a date object', function(finished) {

    const queue = 'publishAfter-date-object';

    let date = new Date();
    date.setUTCSeconds(date.getUTCSeconds() + 2);

    const startAfter = date;
    const started = Date.now();

    boss.publishAfter(queue, {something:1}, {retryLimit:0}, startAfter)
      .then(() => boss.fetch(queue))
      .then(job => assert.strictEqual(job, null))
      .then(() => Promise.delay(2000))
      .then(() => boss.fetch(queue))
      .then(job => {
        assert.isOk(job);
        finished();
      });

  });

});



