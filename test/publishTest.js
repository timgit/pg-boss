const assert = require('chai').assert;
const helper = require('./testHelper');

describe('publish', function(){

    this.timeout(10000);

    let boss;

    before(async () => { boss = await helper.start() })
    after(() => boss.stop())

    it('should fail with no arguments', function(finished) {
        boss.publish()
            .catch(() => finished())
    });

    it('should fail with a function for data', function(finished) {
        boss.publish('job', () => true)
            .catch(() => finished())
    });

    it('should fail with a function for options', function(finished) {
        boss.publish('job', 'data', () => true)
            .catch(() => finished());
    });

    it('should accept single string argument', async function() {
        const queue = 'publishNameOnly'
        await boss.publish(queue)
    });

    it('should accept job object argument with only name', async function() {
        const queue = 'publishqueueOnly'
        await boss.publish({name: queue})
    });


    it('should accept job object with name and data only', async function() {
        const queue = 'publishqueueAndData'
        const message = 'hi'

        await boss.publish({name: queue, data: {message}})
        
        const job = await boss.fetch(queue)

        assert.equal(message, job.data.message)
    });


    it('should accept job object with name and options only', async function(){
        const queue = 'publishqueueAndOptions';
        const options = {someCrazyOption:'whatever'};

        await boss.publish({name: queue, options})
        
        const job = await boss.fetch(queue)
        
        assert.isNull(job.data)
    })
            
});
