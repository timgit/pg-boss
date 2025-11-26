import { PgBoss } from '../../dist/index.js'
import * as helper from '../../test/testHelper.js'
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
      await boss.send(queue)
      await boss.fetch(queue)
    }))

    await delay(1000)
  }
}
