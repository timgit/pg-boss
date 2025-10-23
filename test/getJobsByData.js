const assert = require('node:assert')
const helper = require('./testHelper')

describe('Get jobs by metadata', function () {
  it('should fetch an existing job', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const data = { foo: 'bar', baz: 1 }

    await boss.send(queue, data)

    const [job] = await boss.getJobsByData(queue, data)
    assert(queue === job.name)
    // Metadata should be included
    assert.notEqual(job.state, undefined)
  })

  it('should should fetch existings jobs which data matches given data', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const data = { foo: 'bar', baz: 1 }

    const createdJobs = await Promise.all([data, data].map(data => boss.send(queue, data)))

    const fetchedJobs = await boss.getJobsByData(queue, data)
    assert.equal(fetchedJobs.length, 2)
    for (const createdJob of createdJobs) {
      assert(fetchedJobs.find(fetchedJob => fetchedJob.id === createdJob))
    }
  })

  it('should should not fetch an existing job not matching data', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const data1 = { foo: 'bar', baz: 1 }
    const data2 = { foo: 'bar', baz: 2 }

    const job1 = await boss.send(queue, data1)
    await boss.send(queue, data2)

    const jobs = await boss.getJobsByData(queue, data1)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].id, job1)
  })

  it('should should fetch an existing job which data includes given data', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const data1 = { foo: 'bar', baz: 1 }
    const data2 = { foo: 'bar', baz: 2 }

    const createdJobs = await Promise.all([data1, data2].map(data => boss.send(queue, data)))

    const fetchedJobs = await boss.getJobsByData(queue, { foo: 'bar' })
    assert.equal(fetchedJobs.length, 2)
    for (const createdJob of createdJobs) {
      assert(fetchedJobs.find(fetchedJob => fetchedJob.id === createdJob))
    }
  })

  it('should should fetch zero job if none matches', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const data1 = { foo: 'bar', baz: 1 }
    const data2 = { foo: 'bar', baz: 2 }

    await Promise.all([data1, data2].map(data => boss.send(queue, data)))

    const fetchedJobs = await boss.getJobsByData(queue, { foo: 'baraka' })
    assert.equal(fetchedJobs.length, 0)
  })

  it('should should fetch zero job if given data is a superset of job\'s data', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const data = { foo: 'bar', baz: 1 }

    await boss.send(queue, data)

    const fetchedJobs = await boss.getJobsByData(queue, { ...data, fiz: 'buzz' })
    assert.equal(fetchedJobs.length, 0)
  })

  it('should should only fetch queued jobs when asked', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const data = { foo: 'bar', baz: 1 }

    await boss.send(queue, data)
    const [job1] = await boss.fetch(queue)
    await boss.complete(queue, job1.id)
    const job2 = await boss.send(queue, data)

    const jobs = await boss.getJobsByData(queue, data, { onlyQueued: true })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].id, job2)
  })

  it('should should fetch non-queued jobs when asked', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const data = { foo: 'bar', baz: 1 }

    await boss.send(queue, data)
    const [job1] = await boss.fetch(queue)
    await boss.complete(queue, job1.id)
    const job2 = await boss.send(queue, data)

    const fetchedJobs = await boss.getJobsByData(queue, data, { onlyQueued: false })
    assert.equal(fetchedJobs.length, 2)
    for (const createdJob of [job1.id, job2]) {
      assert(fetchedJobs.find(fetchedJob => fetchedJob.id === createdJob))
    }
  })
})
