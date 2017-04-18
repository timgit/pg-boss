const assert = require('chai').assert;
const helper = require('./testHelper');

describe('fetch', function(){

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

  it('should fetch a single job by name and manually complete', function(finished) {
    let jobName = 'no-subscribe-required';

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



