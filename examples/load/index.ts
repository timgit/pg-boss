import { PgBoss } from '../../src/index.ts'
import * as helper from '../../test/testHelper.ts'
import { delay } from '../../src/tools.ts'

const SCHEMA_COUNT = 60
const QUEUE_COUNT = 200

loadTest()
  .catch(err => {
    console.log(err)
    process.exit(1)
  })

async function loadTest () {
  const schemas = new Array(SCHEMA_COUNT).fill(null).map((_, index) => `schema${index}`)

  for (const schema of schemas) {
    setImmediate(() => init(schema))
    setImmediate(() => typedInit(schema))
  }
}

async function init (schema: string) {
  const config = helper.getConfig()
  const boss = new PgBoss({ ...config, schema, supervise: false, schedule: false })

  boss.on('error', console.error)

  await boss.start()

  console.log('creating queues')

  const queues = new Array(QUEUE_COUNT).fill(null).map((_, index) => `queue${index}`)

  for (const queue of queues) {
    console.log(`creating queue ${schema}.${queue}`)
    await boss.createQueue(queue)
    await boss.work(queue, async () => {})
  }

  console.log('created queues')

  while (true) {
    console.log(`${schema}: sending a job to each one: ${new Date()}`)

    await Promise.all(queues.map(async queue => {
      await boss.send(queue, null)
      await boss.fetch(queue)
    }))

    await delay(1000)
  }
}

async function typedInit (schema: string) {
  const config = helper.getConfig()
  const boss = new PgBoss<{
    queue1: { input: { arg1: string }, output: { completed: { result: string } } }
    queue2: { input: { arg2: number }, output: { completed: { result: number } } }
    queue3: { input: { arg3: object }, output: { completed: { result: object } } }
    queue4: { input: undefined }
  }>({ ...config, schema, supervise: false, schedule: false })

  boss.on('error', console.error)

  await boss.start()

  console.log('creating queues')

  const queues = [
    'queue1',
    'queue2',
    'queue3',
  ] as const

  for (const queue of queues) {
    console.log(`creating queue ${schema}.${queue}`)
    await boss.createQueue(queue)
    await boss.work(queue, async () => { throw new Error('test') })
  }

  console.log('created queues')

  await boss.send('queue1', { arg1: 'hello' })
  await boss.send('queue2', { arg2: 42 })
  await boss.send('queue3', { arg3: { foo: 'bar' } })
  await boss.send('queue4')

  const job = (await boss.findJobs('queue1'))[0]!
  switch (job.state) {
    case 'completed':
      console.log(job.output.result)
      break
    case 'failed':
      console.log(job.output)
      break
  }

  const job4 = (await boss.findJobs('queue4'))[0]!
  switch (job4.state) {
    case 'completed':
      console.log(job4.output)
      break
    case 'failed':
      console.log(job4.output)
      break
  }

  while (true) {
    console.log(`${schema}: sending a job to each one: ${new Date()}`)

    await Promise.all(queues.map(async queue => {
      // await boss.send(queue) <-- fails since input-type does not allow `undefined`.
      // await boss.schedule(queue, '* * * * *') <-- fails since input-type does not allow `undefined`.
      await boss.send('queue4')
      await boss.fetch(queue)
    }))

    await delay(1000)
  }
}
