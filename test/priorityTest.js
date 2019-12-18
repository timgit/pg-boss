const assert = require('chai').assert;
const helper = require('./testHelper');

describe('priority', function(){

  this.timeout(10000);

  let boss;

  before(async () => { boss = await helper.start() })
  after(() => boss.stop())

  it('should process a newer higher priority job before an older lower priority job', async function() {

    const jobName = 'priority-test';

    const low = await boss.publish(jobName)
    const high = await boss.publish(jobName, null, { priority: 1 })

    const job = await boss.fetch(jobName)
    
    assert.equal(job.id, high)

  });

  it('should process several jobs in descending priority order', async function() {

    const queue = 'multiple-priority-test';

    const low = await boss.publish(queue, null, {priority: 1})
    const medium = await boss.publish(queue, null, {priority: 5})
    const high = await boss.publish(queue, null, {priority: 10})
    
    const job1 = await boss.fetch(queue)
    const job2 = await boss.fetch(queue)
    const job3 = await boss.fetch(queue)
    
    assert.equal(job1.id, high)
    assert.equal(job2.id, medium)
    assert.equal(job3.id, low)

  });

});



