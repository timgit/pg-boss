const helper = require('../test/testHelper')

async function schedule () {
  const PgBoss = require('../src')
  const boss = new PgBoss(helper.getConnectionString())

  boss.on('error', console.error)

  await boss.start()

  const queue = 'scheduled-queue'

  await boss.createQueue(queue)

  await boss.schedule(queue, '*/2 * * * *', { arg1: 'schedule me' })

  await boss.work(queue, async ([job]) => {
    console.log(
      `received job ${job.id} with data ${JSON.stringify(job.data)} on ${new Date().toISOString()}`
    )
  })
}

schedule().catch((err) => {
  console.log(err)
  process.exit(1)
})
