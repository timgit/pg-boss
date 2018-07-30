const assert = require('chai').assert;
const helper = require('./testHelper');
const Promise = require('bluebird');

describe('deleteQueue', function() {

  this.timeout(10000);

  let boss;

  before(function(finished){

    helper.start()
      .then(dabauce => {
        boss = dabauce;
        finished();
      });
  });

  after(function(finished) {
    boss.stop().then(() => finished());
  });

  it('should clear a specific queue', function(finished){

    const queue1 = 'delete-named-queue-1';
    const queue2 = 'delete-named-queue-2';
    
    Promise.join(
      boss.publish(queue1),
      boss.publish(queue2)
    )
      .then(() => Promise.join(
        helper.countJobs(`name = $1`, [queue1]),
        helper.countJobs(`name = $1`, [queue2]),
        (q1Count, q2Count) => {
          assert.strictEqual(1, q1Count);
          assert.strictEqual(1, q2Count);
        }
      ))
      .then(() => boss.deleteQueue(queue1))
      .then(() => Promise.join(
        helper.countJobs(`name = $1`, [queue1]),
        helper.countJobs(`name = $1`, [queue2]),
        (q1Count, q2Count) => {
          assert.strictEqual(0, q1Count);
          assert.strictEqual(1, q2Count);
        }
      ))
      .then(() => boss.deleteQueue(queue2))
      .then(() => helper.countJobs(`name = $1`, [queue2]))
      .then(q2Count => {
        assert.strictEqual(0, q2Count);
        finished()
      });
  });

  it('should clear all queues', function(finished){

    const queue1 = 'delete-named-queue-1';
    const queue2 = 'delete-named-queue-2';

    Promise.join(
      boss.publish(queue1),
      boss.publish(queue2)
    )
      .then(() => Promise.join(
        helper.countJobs(`name = $1`, [queue1]),
        helper.countJobs(`name = $1`, [queue2]),
        (q1Count, q2Count) => {
          assert.strictEqual(1, q1Count);
          assert.strictEqual(1, q2Count);
        }
      ))
      .then(() => boss.deleteAllQueues())
      .then(() => Promise.join(
        helper.countJobs(`name = $1`, [queue1]),
        helper.countJobs(`name = $1`, [queue2]),
        (q1Count, q2Count) => {
          assert.strictEqual(0, q1Count);
          assert.strictEqual(0, q2Count);
          finished();
        }
      ));
  });

});
