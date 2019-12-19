const Promise = require('bluebird')
const assert = require('chai').assert
const helper = require('./testHelper')

describe('speed', function () {
  const expectedSeconds = 2
  const jobCount = 10000
  const queue = 'speedTest'

  this.timeout(10000)

  const jobs = new Array(jobCount).fill(null).map((item, index) => ({ name: queue, data: { index } }))

  const testTitle = `should be able to fetch and complete ${jobCount} jobs in ${expectedSeconds} seconds`

  let boss

  before(async () => {
    boss = await helper.start()
    await Promise.map(jobs, job => boss.publish(job.name, job.data))
  })

  after(() => boss.stop())

  it(testTitle, async function () {
    const startTime = new Date()

    const jobs = await boss.fetch(queue, jobCount)
    await boss.complete(jobs.map(job => job.id))

    const elapsed = new Date().getTime() - startTime.getTime()

    console.log(`finished ${jobCount} jobs in ${elapsed}ms`)

    assert.isBelow(elapsed / 1000, expectedSeconds)
  })
})
