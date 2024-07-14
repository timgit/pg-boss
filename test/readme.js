const helper = require('./testHelper')

async function readme () {
  const PgBoss = require('../src')
  const boss = new PgBoss(helper.getConnectionString())

  boss.on('error', console.error)

  await boss.start()

  const queue = 'readme-queue'

  try {
    await boss.createQueue(queue)
  } catch {}

  const id = await boss.send(queue, { arg1: 'read me' })

  console.log(`created job ${id} in queue ${queue}`)

  await boss.work(queue, async job => {
    console.log(`received job ${job.id} with data ${JSON.stringify(job.data)}`)
  })
}

readme()
