const assert = require('chai').assert;
const helper = require('./testHelper');
const Promise = require('bluebird');

describe('delete', async function() {

    this.timeout(10000);

    let boss;

    const config = {
        archiveCompletedJobsEvery:'1 second',
        archiveCheckInterval: 500,
        deleteArchivedJobsEvery: '1 second',
        deleteCheckInterval: 500
    };

    before(async () => { boss = await helper.start(config) })
    after(() => boss.stop())

    it('should delete an archived job', async function(){

        let jobName = 'deleteMe';
        let jobId = await boss.publish(jobName)
        let job = await boss.fetch(jobName)

        assert.equal(jobId, job.id)

        await boss.complete(jobId)

        await Promise.delay(3000)

        let archivedJob = await helper.getArchivedJobById(jobId)

        assert.strictEqual(archivedJob, null)

    });

});
