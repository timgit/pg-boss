const Promise = require('bluebird');
const assert = require('chai').assert;
const helper = require('./testHelper');

describe('complete', function() {

    this.timeout(10000);

    let boss;

    before(async () => { boss = await helper.start() })
    after(() => boss.stop())

    it('should reject missing id argument', function(finished){
        boss.complete().catch(() => finished());
    });

    it('should complete a batch of jobs', async function(){
        const jobName = 'complete-batch';

        await Promise.all([
            boss.publish(jobName),
            boss.publish(jobName),
            boss.publish(jobName)
        ])

        let jobs = await boss.fetch(jobName, 3)

        await boss.complete(jobs.map(job => job.id))

    });

    it('onComplete should have the payload from complete() in the response object', function(finished){

        test()

        async function test() {
            const jobName = 'part-of-something-important';
            const responsePayload = {message: 'super-important-payload', arg2: '123'};
    
            await boss.publish(jobName)
            
            let job = await boss.fetch(jobName)
            
            await boss.complete(job.id, responsePayload)
    
            boss.onComplete(jobName, job => {
                assert.equal(job.data.response.message, responsePayload.message);
                assert.equal(job.data.response.arg2, responsePayload.arg2);
    
                finished();
            });
        }

    });

    it('onComplete should have the original payload in request object', function(finished){

        test()

        async function test() {
            const queueName = 'onCompleteRequestTest';
            const requestPayload = {foo:'bar'};
    
            let jobId = await boss.publish(queueName, requestPayload)

            boss.onComplete(queueName, job => {
                assert.equal(jobId, job.data.request.id);
                assert.equal(job.data.request.data.foo, requestPayload.foo);
    
                finished();
            });
            
            let job = await boss.fetch(queueName)
            await boss.complete(job.id)
        }
    
    });

    it('onComplete should have both request and response', function(finished){

        test()

        async function test() {
            const jobName = 'onCompleteFtw'
            const requestPayload = { token:'trivial' }
            const responsePayload = { message: 'so verbose', code: '1234' }
    
            boss.onComplete(jobName, job => {
                assert.equal(jobId, job.data.request.id)
                assert.equal(job.data.request.data.token, requestPayload.token)
                assert.equal(job.data.response.message, responsePayload.message)
                assert.equal(job.data.response.code, responsePayload.code)
    
                finished()
            });
    
            const jobId = await boss.publish(jobName, requestPayload)
            const job = await boss.fetch(jobName)
            await boss.complete(job.id, responsePayload)
        }

    });

    it(`subscribe()'s job.done() should allow sending completion payload`, function(finished){
        
        test()

        async function test() {
            const jobName = 'complete-from-subscribe';
            const responsePayload = {arg1: '123'};
    
            boss.onComplete(jobName, job => {
                assert.equal(job.data.response.arg1, responsePayload.arg1);
                finished();
            });
    
            await boss.publish(jobName)

            boss.subscribe(jobName, job => job.done(null, responsePayload))
        }
        
    });


    it('should unsubscribe an onComplete subscription', async function(){

        const jobName = 'offComplete';

        let receivedCount = 0;
    
        boss.onComplete(jobName, job => {
            receivedCount++;
            boss.offComplete(jobName)
        });

        await boss.publish(jobName)
        const job1 = await boss.fetch(jobName)
        await boss.complete(job1.id)

        await Promise.delay(2000)

        await boss.publish(jobName)
        const job2 = await boss.fetch(jobName)
        await boss.complete(job2.id)
        
        await Promise.delay(2000)

        assert.strictEqual(receivedCount, 1)        

    });

    it('should fetch a completed job', async function(){
        const queue = 'fetchCompleted';

        const jobId = await boss.publish(queue)
        await boss.fetch(queue)
        await boss.complete(jobId)
        const job = await boss.fetchCompleted(queue)
        
        assert.strictEqual(job.data.request.id, jobId)
    });

    it('should not create an extra state job after completion', async function(){
        const queue = 'noMoreExtraStateJobs';

        const jobId = await boss.publish(queue)

        await boss.fetch(queue)
        
        await boss.complete(jobId)

        const job = await boss.fetchCompleted(queue)

        await boss.complete(job.id)
        
        const stateJobCount = await helper.countJobs(`name = $1`, [`${helper.completedJobPrefix}${queue}`])
        
        assert.strictEqual(stateJobCount, 1)
    });

});
