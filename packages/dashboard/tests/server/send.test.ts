import { describe, it, expect, afterEach } from 'vitest'
import { ctx, getBoss, createTestQueue, makeContext } from './helpers'
import { action, loader } from '~/routes/send'
import { parseSendForm } from '~/lib/send-form'
import { openWritesWarning } from '~/lib/read-only.server'

function form (fields: Record<string, string>) {
  const body = new FormData()
  for (const [name, value] of Object.entries(fields)) body.set(name, value)
  return body
}

async function send (fields: Record<string, string>, search = '') {
  return action({
    params: {},
    context: makeContext(ctx),
    request: new Request(`http://localhost/send${search}`, { method: 'POST', body: form(fields) }),
  } as Parameters<typeof action>[0])
}

describe('the send form', () => {
  it('needs a queue, and leaves empty fields to pg-boss', () => {
    expect(parseSendForm(form({}))).toEqual({ error: 'Queue name is required' })
    expect(parseSendForm(form({ queueName: ' billing ', priority: '', data: '' }))).toEqual({ value: { queue: 'billing', data: null, options: undefined } })
  })

  it('takes a JSON object as data, and nothing else', () => {
    expect(parseSendForm(form({ queueName: 'q', data: '{"a":1}' }))).toEqual({ value: { queue: 'q', data: { a: 1 }, options: undefined } })
    expect(parseSendForm(form({ queueName: 'q', data: '{a' }))).toEqual({ error: 'Invalid JSON in data payload' })
    expect(parseSendForm(form({ queueName: 'q', data: '[1]' }))).toEqual({ error: 'Data payload must be a JSON object' })
  })

  it('reads the options, and names the first that is wrong', () => {
    expect(parseSendForm(form({ queueName: 'q', priority: '-2', retryLimit: '0', expireInSeconds: '30', startAfter: '60', singletonKey: 'k' }))).toEqual({
      value: { queue: 'q', data: null, options: { priority: -2, retryLimit: 0, expireInSeconds: 30, startAfter: '60', singletonKey: 'k' } },
    })
    expect(parseSendForm(form({ queueName: 'q', priority: '1.5' }))).toEqual({ error: 'Priority must be an integer' })
    expect(parseSendForm(form({ queueName: 'q', retryLimit: '-1' }))).toEqual({ error: 'Retry limit must be a non-negative integer' })
    expect(parseSendForm(form({ queueName: 'q', expireInSeconds: '0' }))).toEqual({ error: 'Expire in seconds must be a positive integer' })
  })
})

describe('the send page', () => {
  it('sends the job and goes on to its queue, keeping the schema in the link', async () => {
    await createTestQueue('test-queue')

    const result = await send({ queueName: 'test-queue', data: '{"to":"a@example.com"}', priority: '3' }, '?schema=reporting')

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).headers.get('location')).toBe('/queues/test-queue?schema=reporting')
    const [job] = await getBoss().findJobs('test-queue')
    expect(job).toMatchObject({ data: { to: 'a@example.com' }, priority: 3 })
  })

  it('says why when the queue doesn\'t exist', async () => {
    const result = await send({ queueName: 'no-such-queue' })

    expect(result).toEqual({ error: expect.stringMatching(/^Failed to send job: /) })
  })

  it('says so when the queue\'s policy keeps the job out', async () => {
    await createTestQueue('short-queue', { policy: 'short' })
    await send({ queueName: 'short-queue', singletonKey: 'only' })

    expect(await send({ queueName: 'short-queue', singletonKey: 'only' })).toEqual({ error: expect.stringContaining('didn\'t create the job') })
  })

  it('shows the form unless the dashboard is read-only', () => {
    const original = process.env.PGBOSS_DASHBOARD_READ_ONLY
    try {
      delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      expect(loader()).toEqual({ readOnly: null })

      process.env.PGBOSS_DASHBOARD_READ_ONLY = 'true'
      expect(loader().readOnly).toMatch(/read-only/)
    } finally {
      if (original === undefined) delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      else process.env.PGBOSS_DASHBOARD_READ_ONLY = original
    }
  })
})

describe('the open writes warning', () => {
  const original = process.env.PGBOSS_DASHBOARD_READ_ONLY

  afterEach(() => {
    if (original === undefined) delete process.env.PGBOSS_DASHBOARD_READ_ONLY
    else process.env.PGBOSS_DASHBOARD_READ_ONLY = original
  })

  it('warns a dashboard that checks auth, has no credential and allows changes', () => {
    delete process.env.PGBOSS_DASHBOARD_READ_ONLY
    expect(openWritesWarning(true, false)).toMatch(/anyone who can reach this dashboard/)
  })

  it('says nothing with a credential, in read-only mode, or when the host authenticates', () => {
    delete process.env.PGBOSS_DASHBOARD_READ_ONLY
    expect(openWritesWarning(true, true)).toBeNull()
    expect(openWritesWarning(false, false)).toBeNull()

    process.env.PGBOSS_DASHBOARD_READ_ONLY = 'true'
    expect(openWritesWarning(true, false)).toBeNull()
  })
})
