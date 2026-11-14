import { describe, it, expect } from 'vitest'
import { ctx, getBoss, createTestQueue, makeContext } from './helpers'
import { action as publishAction, loader as publishLoader } from '~/routes/publish'
import { parsePublishForm } from '~/lib/publish-form'
import { publishFailure } from '~/lib/publish.server'

function form (fields: Record<string, string>) {
  const body = new FormData()
  for (const [name, value] of Object.entries(fields)) body.set(name, value)
  return body
}

async function publish (fields: Record<string, string>, search = '') {
  return publishAction({
    params: {},
    context: makeContext(ctx),
    request: new Request(`http://localhost/publish${search}`, { method: 'POST', body: form(fields) }),
  } as Parameters<typeof publishAction>[0])
}

describe('the publish form', () => {
  it('needs an event, and reads the data and options as the send form does', () => {
    expect(parsePublishForm(form({}))).toEqual({ error: 'An event name is required' })
    expect(parsePublishForm(form({ event: ' user.created ' }))).toEqual({ value: { event: 'user.created', data: null, options: undefined } })
    expect(parsePublishForm(form({ event: 'user.created', data: '{"id":1}', priority: '3', singletonKey: 'k' }))).toEqual({
      value: { event: 'user.created', data: { id: 1 }, options: { priority: 3, singletonKey: 'k' } },
    })
    expect(parsePublishForm(form({ event: 'user.created', data: '[1]' }))).toEqual({ error: 'Data payload must be a JSON object' })
    expect(parsePublishForm(form({ event: 'user.created', retryLimit: '-1' }))).toEqual({ error: 'Retry limit must be a non-negative integer' })
  })

  it('names each queue that failed when pg-boss refuses several sends', () => {
    expect(publishFailure(new AggregateError(['a: boom', 'b: bang'], "publish('e') failed for 2 of 2 subscribed queue(s)")))
      .toBe("publish('e') failed for 2 of 2 subscribed queue(s): a: boom; b: bang")
    expect(publishFailure(new Error('down'))).toBe('down')
  })
})

describe('publishing an event', () => {
  it('sends one job to each subscribed queue and opens the Jobs page on those queues, keeping the schema', async () => {
    await createTestQueue('test-queue')
    await createTestQueue('other-queue')
    await getBoss().subscribe('user.created', 'test-queue')
    await getBoss().subscribe('user.created', 'other-queue')

    const result = await publish({ event: 'user.created', data: '{"id":7}' }, '?schema=reporting')

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).headers.get('location')).toBe('/jobs?queues=other-queue%2Ctest-queue&schema=reporting')
    for (const queue of ['test-queue', 'other-queue']) {
      expect((await getBoss().findJobs(queue)).map((job) => job.data)).toEqual([{ id: 7 }])
    }
  })

  it('refuses an event no queue is subscribed to', async () => {
    expect(await publish({ event: 'nobody.listens' })).toEqual({ error: 'No queue is subscribed to nobody.listens, so publishing it would send nothing.' })
  })

  it('shows the form unless the dashboard is read-only', () => {
    const original = process.env.PGBOSS_DASHBOARD_READ_ONLY
    try {
      delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      expect(publishLoader()).toEqual({ readOnly: null })

      process.env.PGBOSS_DASHBOARD_READ_ONLY = 'true'
      expect(publishLoader().readOnly).toMatch(/read-only/)
    } finally {
      if (original === undefined) delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      else process.env.PGBOSS_DASHBOARD_READ_ONLY = original
    }
  })
})
