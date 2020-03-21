const Promise = require('bluebird')
const helper = require('./testHelper')

describe('speed', function () {
  const expectedSeconds = 2
  const jobCount = 10000
  const queue = 'speedTest'

  const jobs = new Array(jobCount).fill(null).map((item, index) => ({ name: queue, data: { index } }))

  const testTitle = `should be able to fetch and complete ${jobCount} jobs in ${expectedSeconds} seconds`

  let boss

  beforeEach(async function () {
    // TODO: figure out why this is taking longer than before
    this.timeout(100 * 1000)

    const defaults = { noSupervisor: true, min: 10, max: 10 }
    boss = await helper.start({ ...this.currentTest.bossConfig, ...defaults })
    await Promise.map(jobs, job => boss.publish(job.name, job.data))
  })

  afterEach(async function () { await boss.stop() })

  it(testTitle, async function () {
    this.timeout(expectedSeconds * 1000)
    this.slow(0)
    this.retries(1)

    const jobs = await boss.fetch(queue, jobCount)
    await boss.complete(jobs.map(job => job.id))
  })
})
