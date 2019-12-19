const assert = require('chai').assert;
const helper = require('./testHelper');

describe('singleton', function() {

    this.timeout(10000);

    let boss;

    before(async () => { boss = await helper.start() })
    after(() => boss.stop())
    beforeEach(() => helper.empty())

    it('should not allow more than 1 pending job at a time with the same key', async function() {

        const queue = 'singleton-1-pending'
        const singletonKey = 'a'

        const jobId = await boss.publish(queue, null, { singletonKey })

        assert.isOk(jobId)

        const jobId2 = await boss.publish(queue, null, { singletonKey })

        assert.isNotOk(jobId2)

    });

    it('should not allow more than 1 complete job with the same key with an interval', async function() {

        const queue = 'singleton-1-complete'
        const singletonKey = 'a'
        const singletonMinutes = 1

        await boss.publish(queue, null, { singletonKey, singletonMinutes })
        const job = await boss.fetch(queue)

        await boss.complete(job.id)

        const jobId = await boss.publish(queue, null, { singletonKey, singletonMinutes })

        assert.isNotOk(jobId)
    });

    it('should allow more than 1 pending job at the same time with different keys', async function () {

        const queue = 'singleton';

        const jobId = await boss.publish(queue, null, {singletonKey: 'a'})
        
        assert.isOk(jobId);
        
        const jobId2 = await boss.publish(queue, null, {singletonKey: 'b'})
        
        assert.isOk(jobId2);

    });

    it('publishOnce() should work', async function () {

        const queue = 'publishOnce'
        const key = 'only-once-plz'

        const jobId = await boss.publishOnce(queue, null, null, key)
        
        assert.isOk(jobId)
        
        const jobId2 = await boss.publishOnce(queue, null, null, key)
        
        assert.strictEqual(jobId2, null)

    });

});
