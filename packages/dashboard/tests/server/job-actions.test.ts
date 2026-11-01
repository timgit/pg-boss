import { describe, it, expect, afterEach } from 'vitest'
import { Hono } from 'hono'
import { ctx, getBoss, createTestQueue, sendTestJob, fetchTestJob, failTestJob, cancelTestJob, makeContext } from './helpers'
import { action } from '~/routes/queues.$name.jobs.$jobId'
import { configureReadOnly, isReadOnly } from '~/lib/read-only.server'

async function act (name: string, jobId: string, intent: string) {
  const body = new FormData()
  body.set('intent', intent)

  return action({
    params: { name, jobId },
    context: makeContext(ctx),
    request: new Request(`http://localhost/queues/${name}/jobs/${jobId}`, { method: 'POST', body }),
  } as Parameters<typeof action>[0])
}

async function stateOf (name: string, jobId: string) {
  const [job] = await getBoss().findJobs(name, { id: jobId })
  return job?.state
}

describe('the job page action', () => {
  it('retries a failed job', async () => {
    await createTestQueue('test-queue', { retryLimit: 0 })
    const jobId = await sendTestJob('test-queue', {})
    await fetchTestJob('test-queue')
    await failTestJob('test-queue', jobId!)

    const result = await act('test-queue', jobId!, 'retry')

    expect(result).toEqual({ success: true, message: 'Job queued for retry' })
    expect(await stateOf('test-queue', jobId!)).toBe('retry')
  })

  it('cancels a created job, and resumes it', async () => {
    await createTestQueue('test-queue')
    const jobId = await sendTestJob('test-queue', {})

    expect(await act('test-queue', jobId!, 'cancel')).toEqual({ success: true, message: 'Job canceled' })
    expect(await stateOf('test-queue', jobId!)).toBe('cancelled')

    expect(await act('test-queue', jobId!, 'resume')).toEqual({ success: true, message: 'Job resumed' })
    expect(await stateOf('test-queue', jobId!)).toBe('created')
  })

  it('says why when nothing changed', async () => {
    await createTestQueue('test-queue')
    const jobId = await sendTestJob('test-queue', {})
    await cancelTestJob('test-queue', jobId!)

    const result = await act('test-queue', jobId!, 'retry')

    expect(result).toEqual({ success: false, message: 'Job could not be retried (only failed jobs can be retried)' })
    expect(await stateOf('test-queue', jobId!)).toBe('cancelled')
  })

  it('refuses delete, which is Pro only', async () => {
    await createTestQueue('test-queue')
    const jobId = await sendTestJob('test-queue', {})

    const result = await act('test-queue', jobId!, 'delete')

    expect(result).toEqual({ success: false, message: 'Unknown action' })
    expect(await stateOf('test-queue', jobId!)).toBe('created')
  })
})

describe('read-only mode', () => {
  const original = process.env.PGBOSS_DASHBOARD_READ_ONLY

  afterEach(() => {
    if (original === undefined) delete process.env.PGBOSS_DASHBOARD_READ_ONLY
    else process.env.PGBOSS_DASHBOARD_READ_ONLY = original
  })

  function app () {
    const hono = new Hono()
    configureReadOnly(hono)
    hono.all('*', (c) => c.text('reached'))
    return hono
  }

  it('is off unless the variable says true or 1', () => {
    delete process.env.PGBOSS_DASHBOARD_READ_ONLY
    expect(isReadOnly()).toBe(false)

    process.env.PGBOSS_DASHBOARD_READ_ONLY = 'false'
    expect(isReadOnly()).toBe(false)

    process.env.PGBOSS_DASHBOARD_READ_ONLY = 'true'
    expect(isReadOnly()).toBe(true)

    process.env.PGBOSS_DASHBOARD_READ_ONLY = '1'
    expect(isReadOnly()).toBe(true)
  })

  it('refuses a post and still serves pages', async () => {
    process.env.PGBOSS_DASHBOARD_READ_ONLY = 'true'

    const refused = await app().request('/queues/q/jobs/1', { method: 'POST' })
    expect(refused.status).toBe(403)
    expect(await refused.text()).toMatch(/read-only/)

    const page = await app().request('/queues/q/jobs/1')
    expect(page.status).toBe(200)
  })

  it('lets a post through when off', async () => {
    delete process.env.PGBOSS_DASHBOARD_READ_ONLY

    const res = await app().request('/queues/q/jobs/1', { method: 'POST' })
    expect(res.status).toBe(200)
  })
})
