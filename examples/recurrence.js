import { PgBoss } from '../src/index.ts'
import * as helper from '../test/testHelper.ts'

// A recurrence kind registered by this process. pg-boss stores the kind and the expression; the
// parser stays here, the same way a work() handler does. This one reads the expression as a plain
// number of seconds, but the same shape fits an RRULE engine or anything else that can answer
// "what is the next occurrence after this instant".
const everyNSeconds = {
  next: (expression, after) => new Date(after.getTime() + Number(expression) * 1000),
  validate: (expression) => {
    if (!Number.isFinite(Number(expression))) {
      throw new Error(`expected a number of seconds, received "${expression}"`)
    }
  }
}

async function recurrence () {
  const boss = new PgBoss({
    connectionString: helper.getConnectionString(),
    recurrences: { seconds: everyNSeconds }
  })

  boss.on('error', console.error)

  await boss.start()

  const queue = 'recurrence-queue'

  await boss.createQueue(queue)

  await boss.schedule(queue, { kind: 'seconds', expression: '10' }, { arg1: 'schedule me' }, { missed: 'once' })

  const [schedule] = await boss.getSchedules(queue)

  console.log(`${schedule.kind} schedule "${schedule.expression}" is next due ${schedule.nextRunAt.toISOString()}`)

  await boss.work(queue, async ([job]) => {
    console.log(`received job ${job.id} with data ${JSON.stringify(job.data)} on ${new Date().toISOString()}`)
  })
}

recurrence()
  .catch(err => {
    console.log(err)
    process.exit(1)
  })
