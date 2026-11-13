import { describe, it, expect } from 'vitest'
import { ctx, getBoss, createTestQueue, makeContext } from './helpers'
import { action as addAction, loader as addLoader } from '~/routes/schedules.new'
import { action as scheduleAction } from '~/routes/schedules.$name.$key'
import { parseScheduleForm } from '~/lib/schedule-form'

function form (fields: Record<string, string>) {
  const body = new FormData()
  for (const [name, value] of Object.entries(fields)) body.set(name, value)
  return body
}

async function add (fields: Record<string, string>, search = '') {
  return addAction({
    params: {},
    context: makeContext(ctx),
    request: new Request(`http://localhost/schedules/new${search}`, { method: 'POST', body: form(fields) }),
  } as Parameters<typeof addAction>[0])
}

async function unschedule (name: string, key: string, intent = 'unschedule') {
  return scheduleAction({
    params: { name, key },
    context: makeContext(ctx),
    request: new Request(`http://localhost/schedules/${name}/${key}`, { method: 'POST', body: form({ intent }) }),
  } as Parameters<typeof scheduleAction>[0])
}

describe('the new schedule form', () => {
  it('needs a queue and an expression, and leaves empty fields to pg-boss', () => {
    expect(parseScheduleForm(form({}))).toEqual({ error: 'Queue name is required' })
    expect(parseScheduleForm(form({ queueName: 'q' }))).toEqual({ error: 'An expression is required' })
    expect(parseScheduleForm(form({ queueName: ' q ', cron: '0 8 * * *', key: '', data: '' }))).toEqual({
      value: { queue: 'q', cron: '0 8 * * *', data: null, options: undefined },
    })
  })

  it('takes a five-part cron expression or a recurrence rule', () => {
    expect(parseScheduleForm(form({ queueName: 'q', cron: '0 8 * *' }))).toEqual({ error: expect.stringMatching(/^A cron expression has 5 parts/) })
    expect(parseScheduleForm(form({ queueName: 'q', cron: 'FREQ=DAILY;BYHOUR=8' }))).toMatchObject({ value: { cron: 'FREQ=DAILY;BYHOUR=8' } })
  })

  it('reads the options, and names the first that is wrong', () => {
    expect(parseScheduleForm(form({ queueName: 'q', cron: '* * * * *', key: 'k', timezone: 'America/New_York', missed: 'once', priority: '2', retryLimit: '0', expireInSeconds: '30', data: '{"a":1}' }))).toEqual({
      value: { queue: 'q', cron: '* * * * *', data: { a: 1 }, options: { key: 'k', tz: 'America/New_York', missed: 'once', priority: 2, retryLimit: 0, expireInSeconds: 30 } },
    })
    expect(parseScheduleForm(form({ queueName: 'q', cron: '* * * * *', missed: 'twice' }))).toEqual({ error: 'Missed occurrences must be skip or once' })
    expect(parseScheduleForm(form({ queueName: 'q', cron: '* * * * *', data: '[1]' }))).toEqual({ error: 'Data payload must be a JSON object' })
    expect(parseScheduleForm(form({ queueName: 'q', cron: '* * * * *', retryLimit: '-1' }))).toEqual({ error: 'Retry limit must be a non-negative integer' })
  })
})

describe('adding and removing a schedule', () => {
  it('adds the schedule and goes on to its page, keeping the schema in the link', async () => {
    await createTestQueue('test-queue')

    const result = await add({ queueName: 'test-queue', cron: '0 8 * * *', key: 'morning', data: '{"report":"daily"}' }, '?schema=reporting')

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).headers.get('location')).toBe('/schedules/test-queue/morning?schema=reporting')
    expect(await getBoss().getSchedules('test-queue', 'morning')).toEqual([expect.objectContaining({ cron: '0 8 * * *', data: { report: 'daily' } })])
  })

  it('names the default key in the link when the schedule has none', async () => {
    await createTestQueue('test-queue')

    const result = await add({ queueName: 'test-queue', cron: '0 8 * * *' })

    expect((result as Response).headers.get('location')).toBe('/schedules/test-queue/__default__')
  })

  it('says why when the queue doesn\'t exist', async () => {
    expect(await add({ queueName: 'no-such-queue', cron: '0 8 * * *' })).toEqual({ error: expect.stringMatching(/^Failed to schedule the job: /) })
  })

  it('removes the schedule it names, and only that one', async () => {
    await createTestQueue('test-queue')
    await getBoss().schedule('test-queue', '0 8 * * *', undefined, { key: 'morning' })
    await getBoss().schedule('test-queue', '0 20 * * *', undefined, { key: 'evening' })

    const result = await unschedule('test-queue', 'morning')

    expect((result as Response).headers.get('location')).toBe('/schedules')
    expect((await getBoss().getSchedules('test-queue')).map((schedule) => schedule.key)).toEqual(['evening'])
  })

  it('removes the schedule with no key from its default link', async () => {
    await createTestQueue('test-queue')
    await getBoss().schedule('test-queue', '0 8 * * *')

    await unschedule('test-queue', '__default__')

    expect(await getBoss().getSchedules('test-queue')).toEqual([])
  })

  it('refuses any other intent', async () => {
    expect(await unschedule('test-queue', 'morning', 'drop')).toEqual({ error: 'Unknown action' })
  })

  it('shows the form unless the dashboard is read-only', () => {
    const original = process.env.PGBOSS_DASHBOARD_READ_ONLY
    try {
      delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      expect(addLoader()).toEqual({ readOnly: null })

      process.env.PGBOSS_DASHBOARD_READ_ONLY = 'true'
      expect(addLoader().readOnly).toMatch(/read-only/)
    } finally {
      if (original === undefined) delete process.env.PGBOSS_DASHBOARD_READ_ONLY
      else process.env.PGBOSS_DASHBOARD_READ_ONLY = original
    }
  })
})
