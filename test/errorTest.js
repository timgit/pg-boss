const assert = require('chai').assert;
const helper = require('./testHelper');
const Promise = require('bluebird');

describe('error', function(){

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

  it('should handle an error in a subscriber and not blow up', function(finished) {

    this.timeout(3000);

    const queue = 'error-handling';
    let subscribeCount = 0;

    Promise.join(
      boss.publish(queue),
      boss.publish(queue)
    )
      .then(() => {
        boss.subscribe(queue, job => {

          subscribeCount++;

          if(subscribeCount === 1)
            throw new Error('test - nothing to see here');
          else {
            job.done()
              .then(() => finished());
          }

        });
      });

  });

});



