const helper = require('./testHelper')

async function readme () {
  const PgBoss = require('../src')
  const boss = new PgBoss(helper.getConnectionString())

  boss.on('error', console.error)

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
