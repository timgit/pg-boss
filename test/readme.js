const helper = require('./testHelper')

async function readme () {
  const PgBoss = require('../src')
  const boss = new PgBoss(helper.getConnectionString())

  let errConnectionRetries = 0

  boss.on('error', error => {
    console.error(error)

    if (error.code === 'ECONNREFUSED') {
      errConnectionRetries++
    }

    if (errConnectionRetries > 2) {
      console.log(`Connection lost to postgres after ${errConnectionRetries} retries.  Stopping.`)
      boss.stop().catch(console.error)
    }
  })

  await boss.start()

  const queue = 'some-queue'

  await boss.schedule(queue, '* * * * *')

  console.log(`created cronjob in queue ${queue}`)

  await boss.work(queue, someAsyncJobHandler)
}

async function someAsyncJobHandler (job) {
  console.log(`running job ${job.id}`)
}

readme()
