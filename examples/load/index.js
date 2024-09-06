const helper = require('../../test/testHelper')
const { delay } = require('../../src/tools')

loadTest()
  .catch(err => {
    console.log(err)
    process.exit(1)
  })

async function loadTest () {
  const PgBoss = require('../../src')
  const config = helper.getConfig()
  const boss = new PgBoss({ ...config, supervise: true, max: 100 })

  boss.on('error', console.error)

  await boss.start()

  const queueCount = 200

  console.log('creating queues')

  const queues = new Array(queueCount).fill(null).map((_, index) => `queue${index}`)

  await Promise.all(queues.map(async queue => {
    console.log(`creating queue ${queue}`)
    await boss.createQueue(queue)
    await boss.work(queue, () => {})
  }))

  console.log('created queues')

  while (true) {
    console.log(`sending a job to each one: ${new Date()}`)

    await Promise.all(queues.map(async queue => {
      await boss.send(queue)
      await boss.fetch(queue)
    }))

    await delay(1000)
  }
}
