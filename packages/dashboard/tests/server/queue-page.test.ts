import { describe, it, expect } from 'vitest'
import { ctx, createTestQueue, makeContext } from './helpers'
import { isDeadLetterQueue } from '~/lib/queries.server'
import { loader } from '~/routes/queues.$name'

async function loadQueue (name: string) {
  return loader({
    params: { name },
    context: makeContext(ctx),
    request: new Request(`http://localhost/queues/${name}`),
  } as Parameters<typeof loader>[0])
}

describe('isDeadLetterQueue', () => {
  it('reports a queue another queue dead-letters into', async () => {
    await createTestQueue('test-dlq')
    await createTestQueue('test-queue', { deadLetter: 'test-dlq' })

    expect(await isDeadLetterQueue(ctx.connectionString, ctx.schema, 'test-dlq')).toBe(true)
    expect(await isDeadLetterQueue(ctx.connectionString, ctx.schema, 'test-queue')).toBe(false)
  })
})

describe('queue page loader', () => {
  // What the header's overlay slot is told, so it can offer an action on a dead letter queue.
  it('says whether the queue is a dead letter queue', async () => {
    await createTestQueue('test-dlq')
    await createTestQueue('test-queue', { deadLetter: 'test-dlq' })

    expect((await loadQueue('test-dlq')).isDeadLetter).toBe(true)
    expect((await loadQueue('test-queue')).isDeadLetter).toBe(false)
  })
})
