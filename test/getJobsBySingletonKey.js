const assert = require('node:assert')
const helper = require('./testHelper')

describe('Get jobs by singleton key', function () {
  it('should fetch an existing job', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send({ name: queue, options: { singletonKey: 'a' } })

    const [job] = await boss.getJobsBySingletonKey(queue, 'a')
    assert(queue === job.name)
    // Metadata should be included
    assert.notEqual(job.state, undefined)
  })

  it('should fetch existings jobs which singleton key matches given key', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const createdJobs = await Promise.all(['a', 'a'].map(key =>
      boss.send({ name: queue, options: { singletonKey: key } })
    ))

    const fetchedJobs = await boss.getJobsBySingletonKey(queue, 'a')
    assert.equal(fetchedJobs.length, 2)
    for (const createdJob of createdJobs) {
      assert(fetchedJobs.find(fetchedJob => fetchedJob.id === createdJob))
    }
  })

  it('should not fetch an existing job not matching key', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const createdJobs = await Promise.all(['a', 'b'].map(key =>
      boss.send({ name: queue, options: { singletonKey: key } })
    ))

    const fetchedJobs = await boss.getJobsBySingletonKey(queue, 'a')
    assert.equal(fetchedJobs.length, 1)
    assert.equal(fetchedJobs[0].id, createdJobs[0])
  })

  it('should fetch zero job if none matches', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await Promise.all(['a', 'b'].map(key =>
      boss.send({ name: queue, options: { singletonKey: key } })
    ))

    const fetchedJobs = await boss.getJobsBySingletonKey(queue, 'c')
    assert.equal(fetchedJobs.length, 0)
  })

  it('should only fetch queued jobs when asked', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send({ name: queue, options: { singletonKey: 'a' } })
    const [{ id: job1 }] = await boss.fetch(queue)
    await boss.complete(queue, job1)
    const job2 = await boss.send({ name: queue, options: { singletonKey: 'a' } })

    const fetchedJobs = await boss.getJobsBySingletonKey(queue, 'a', { onlyQueued: true })
    assert.equal(fetchedJobs.length, 1)
    assert.equal(fetchedJobs[0].id, job2)
  })

  it('should fetch non-queued jobs when asked', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send({ name: queue, options: { singletonKey: 'a' } })
    const [{ id: job1 }] = await boss.fetch(queue)
    await boss.complete(queue, job1)
    const job2 = await boss.send({ name: queue, options: { singletonKey: 'a' } })

    const fetchedJobs = await boss.getJobsBySingletonKey(queue, 'a', { onlyQueued: false })
    assert.equal(fetchedJobs.length, 2)
    for (const createdJob of [job1, job2]) {
      assert(fetchedJobs.find(fetchedJob => fetchedJob.id === createdJob))
    }
  })
})
