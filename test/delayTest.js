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

        boss.subscribe('wait', async job => {
            let start = new Date(job.data.submitted);
            let end = new Date();

            let elapsedSeconds = Math.floor((end-start)/1000);

            await job.done()

            assert.isAtLeast(delaySeconds, elapsedSeconds)

            finished()
        });

        boss.publish('wait', {message: 'hold your horses', submitted: Date.now()}, {startAfter: delaySeconds});

    });

    it('should wait until after a date time string', async function() {

        const queue = 'delay-date-string'

        let date = new Date()

        date.setUTCSeconds(date.getUTCSeconds() + 2)

        const startAfter = date.toISOString()

        await boss.publish(queue, null, {startAfter})

        const job = await boss.fetch(queue)
        
        assert.strictEqual(job, null)

        await Promise.delay(2000)

        const job2 = await boss.fetch(queue)
        
        assert.isOk(job2)

    });

    it('should wait until after a date object', async function() {

        const queue = 'delay-date-object'

        let date = new Date()
        date.setUTCSeconds(date.getUTCSeconds() + 2)

        const startAfter = date

        await boss.publish(queue, null, { startAfter })
        
        const job = await boss.fetch(queue)

        assert.strictEqual(job, null)

        await Promise.delay(2000)

        const job2 = await boss.fetch(queue)
        
        assert.isOk(job2)

    });

    it('should work with publishAfter() and a date object', async function() {

        const queue = 'publishAfter-date-object'

        let date = new Date()
        date.setUTCSeconds(date.getUTCSeconds() + 2)

        const startAfter = date

        await boss.publishAfter(queue, {something:1}, {retryLimit:0}, startAfter)

        const job = await boss.fetch(queue)
        
        assert.strictEqual(job, null)
        
        await Promise.delay(2000)

        const job2 = await boss.fetch(queue)
        
        assert.isOk(job2)
    })

});
