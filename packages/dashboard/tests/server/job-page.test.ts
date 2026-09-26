import { describe, it, expect } from 'vitest'
import { ctx, getBoss, createTestQueue, sendTestJob, fetchTestJob, failTestJob, makeContext } from './helpers'
import { getJobPageContext, getLinkedJob } from '~/lib/queries.server'
import { loader } from '~/routes/queues.$name.jobs.$jobId'

async function loadJob (name: string, jobId: string) {
  return loader({
    params: { name, jobId },
    context: makeContext(ctx),
    request: new Request(`http://localhost/queues/${name}/jobs/${jobId}`),
  } as Parameters<typeof loader>[0])
}

// Fail a job in `queue` once, which sends a copy to its dead letter queue, and return the copy.
async function deadLetter (queue: string, dlq: string, jobId: string, message: string) {
  await fetchTestJob(queue)
  await failTestJob(queue, jobId, new Error(message))
  const [copy] = (await getBoss().findJobs(dlq)).filter(j => j.sourceId === jobId)
  return copy
}

describe('getJobPageContext', () => {
  it('reports a queue another queue dead-letters into', async () => {
    await createTestQueue('test-dlq')
    await createTestQueue('test-queue', { deadLetter: 'test-dlq' })

    const context = await getJobPageContext(ctx.connectionString, ctx.schema, 'test-dlq')

    expect(context.isDeadLetterQueue).toBe(true)
  })

  it('does not report a queue nothing dead-letters into', async () => {
    await createTestQueue('test-dlq')
    await createTestQueue('test-queue', { deadLetter: 'test-dlq' })

    const context = await getJobPageContext(ctx.connectionString, ctx.schema, 'test-queue')

    expect(context.isDeadLetterQueue).toBe(false)
  })

  it("returns the database's clock", async () => {
    await createTestQueue('test-queue')

    const { now } = await getJobPageContext(ctx.connectionString, ctx.schema, 'test-queue')

    expect(now).toBeInstanceOf(Date)
    expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(60_000)
  })
})

describe('getLinkedJob', () => {
  it('returns a job by queue and id', async () => {
    await createTestQueue('test-queue')
    const jobId = await sendTestJob('test-queue', { foo: 'bar' })

    const job = await getLinkedJob(ctx.connectionString, ctx.schema, 'test-queue', jobId!)

    expect(job).toMatchObject({ id: jobId, name: 'test-queue', state: 'created', retryCount: 0 })
    expect(job!.createdOn).toBeInstanceOf(Date)
    expect(job!.startedOn).toBeNull()
  })

  it('returns null when the job is in another queue', async () => {
    await createTestQueue('test-queue')
    await createTestQueue('other-queue')
    const jobId = await sendTestJob('test-queue', {})

    expect(await getLinkedJob(ctx.connectionString, ctx.schema, 'other-queue', jobId!)).toBeNull()
  })

  it('returns null for an id that is not a uuid', async () => {
    await createTestQueue('test-queue')

    expect(await getLinkedJob(ctx.connectionString, ctx.schema, 'test-queue', 'not-a-uuid')).toBeNull()
  })
})

describe('job page loader', () => {
  it('loads a plain job with no lineage', async () => {
    await createTestQueue('test-queue')
    const jobId = await sendTestJob('test-queue', { foo: 'bar' })

    const data = await loadJob('test-queue', jobId!)

    expect(data.job.id).toBe(jobId)
    expect(data.isDeadLetterQueue).toBe(false)
    expect(data.source).toBeNull()
    expect(data.root).toBeNull()
    expect(Number.isNaN(Date.parse(data.now))).toBe(false)
  })

  it('finds the source of a first dead-lettering, which is also its root', async () => {
    await createTestQueue('test-dlq')
    await createTestQueue('test-queue', { deadLetter: 'test-dlq', retryLimit: 0 })
    const jobId = await sendTestJob('test-queue', {})
    const copy = await deadLetter('test-queue', 'test-dlq', jobId!, 'card declined')

    const data = await loadJob('test-dlq', copy.id)

    expect(data.isDeadLetterQueue).toBe(true)
    expect(data.source).toMatchObject({ id: jobId, name: 'test-queue', state: 'failed' })
    // The root is the source here, so there is nothing more to look up.
    expect(data.job.sourceRootId).toBe(jobId)
    expect(data.root).toBeNull()
  })

  it('finds the root and the source after a redrive', async () => {
    await createTestQueue('test-dlq')
    await createTestQueue('test-queue', { deadLetter: 'test-dlq', retryLimit: 0 })
    const rootId = await sendTestJob('test-queue', {})
    await deadLetter('test-queue', 'test-dlq', rootId!, 'first failure')

    await getBoss().redrive('test-dlq')
    const [redriven] = (await getBoss().findJobs('test-queue')).filter(j => j.state === 'created')
    const copy = await deadLetter('test-queue', 'test-dlq', redriven.id, 'second failure')

    const data = await loadJob('test-dlq', copy.id)

    expect(data.rootQueue).toBe('test-queue')
    expect(data.root).toMatchObject({ id: rootId, state: 'failed' })
    expect(data.source).toMatchObject({ id: redriven.id, state: 'failed' })
  })

  it('looks for the root of a redriven job in its own queue', async () => {
    await createTestQueue('test-dlq')
    await createTestQueue('test-queue', { deadLetter: 'test-dlq', retryLimit: 0 })
    const rootId = await sendTestJob('test-queue', {})
    await deadLetter('test-queue', 'test-dlq', rootId!, 'first failure')
    await getBoss().redrive('test-dlq')
    const [redriven] = (await getBoss().findJobs('test-queue')).filter(j => j.state === 'created')

    const data = await loadJob('test-queue', redriven.id)

    expect(data.job.sourceId).toBeNull()
    expect(data.rootQueue).toBe('test-queue')
    expect(data.root).toMatchObject({ id: rootId })
  })

  it('throws a 404 for a job that does not exist', async () => {
    await createTestQueue('test-queue')

    await expect(loadJob('test-queue', '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 404 })
  })
})
