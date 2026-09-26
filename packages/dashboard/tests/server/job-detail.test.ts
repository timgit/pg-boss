import { describe, it, expect } from 'vitest'
import {
  attempts,
  buildTimeline,
  expiresAt,
  formatDuration,
  formatSeconds,
  retention,
  statusLine,
  summarizeOutput,
  tokenizeJson,
  type JobTimes,
} from '~/lib/job-detail'

const NOW = new Date('2026-09-26T17:00:00Z')
const at = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000)
const fmt = (d: Date) => d.toISOString()

function job (overrides: Partial<JobTimes>): JobTimes {
  return {
    state: 'created',
    createdOn: at(-600),
    startAfter: at(-600),
    startedOn: null,
    completedOn: null,
    keepUntil: at(14 * 86_400),
    retryCount: 0,
    retryLimit: 2,
    expireInSeconds: 900,
    deleteAfterSeconds: 7 * 86_400,
    ...overrides,
  }
}

describe('formatDuration', () => {
  it('keeps sub-second precision for short durations', () => {
    expect(formatDuration(3)).toBe('3 ms')
    expect(formatDuration(1200)).toBe('1.2 s')
    expect(formatDuration(42_000)).toBe('42 s')
  })

  it('pads seconds once minutes lead', () => {
    expect(formatDuration(828_000)).toBe('13m 48s')
    expect(formatDuration(3_852_000)).toBe('1h 04m 12s')
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h')
  })

  it('shows whole seconds for a live counter', () => {
    expect(formatDuration(5900, { live: true })).toBe('5 s')
    expect(formatDuration(72_000, { live: true })).toBe('1m 12s')
  })

  it('never goes negative', () => {
    expect(formatDuration(-500)).toBe('0 ms')
  })
})

describe('formatSeconds', () => {
  it('says configured intervals the way a person would', () => {
    expect(formatSeconds(30)).toBe('30 s')
    expect(formatSeconds(900)).toBe('15 min')
    expect(formatSeconds(7200)).toBe('2 h')
    expect(formatSeconds(86_400)).toBe('1 day')
    expect(formatSeconds(7 * 86_400)).toBe('7 days')
  })
})

describe('retention', () => {
  it('deletes a finished job deleteAfterSeconds after it finished', () => {
    const rule = retention(job({ state: 'completed', startedOn: at(-60), completedOn: at(-30) }))
    expect(rule).toMatchObject({ label: 'Deleted', detail: '7 days after completing' })
    expect(rule!.at).toEqual(new Date(at(-30).getTime() + 7 * 86_400_000))
  })

  it('names the way a failed or cancelled job finished', () => {
    expect(retention(job({ state: 'failed', completedOn: at(-30) }))!.detail).toBe('7 days after failing')
    expect(retention(job({ state: 'cancelled', completedOn: at(-30) }))!.detail).toBe('7 days after being cancelled')
  })

  it('keeps a finished job when deleteAfterSeconds is 0', () => {
    expect(retention(job({ state: 'completed', completedOn: at(-30), deleteAfterSeconds: 0 }))).toMatchObject({ label: 'Kept', at: null })
  })

  it('deletes a job that never started at keepUntil', () => {
    expect(retention(job({ state: 'created' }))).toMatchObject({ label: 'Deleted if never run', at: at(14 * 86_400) })
  })

  it('does not delete an active job', () => {
    expect(retention(job({ state: 'active', startedOn: at(-60) }))).toBeNull()
  })
})

describe('attempts', () => {
  it('counts the current run once a job has started', () => {
    expect(attempts(job({ state: 'created' }))).toBe(0)
    expect(attempts(job({ state: 'active', startedOn: at(-5) }))).toBe(1)
    expect(attempts(job({ state: 'failed', retryCount: 2, startedOn: at(-5), completedOn: at(-1) }))).toBe(3)
  })
})

describe('expiresAt', () => {
  it('is started_on plus the time limit for an active job', () => {
    expect(expiresAt(job({ state: 'active', startedOn: at(-60) }))).toEqual(at(840))
  })

  it('is null for a job that is not running', () => {
    expect(expiresAt(job({ state: 'completed', startedOn: at(-60), completedOn: at(-1) }))).toBeNull()
  })
})

describe('buildTimeline', () => {
  const labels = (j: JobTimes) => buildTimeline(j, NOW).map(item => item.label)

  it('shows a waiting job as not started yet', () => {
    expect(labels(job({ state: 'created' }))).toEqual(['Created', 'Eligible to start', 'Started', 'Completed', 'Deleted if never run'])
    expect(buildTimeline(job({ state: 'created' }), NOW)[1].detail).toBe('Immediately')
  })

  it('shows a scheduled job counting down to its start', () => {
    const items = buildTimeline(job({ state: 'created', startAfter: at(3600) }), NOW)
    expect(items[1]).toMatchObject({ label: 'Eligible to start', at: at(3600), detail: 'in 1 h', tone: 'pending' })
  })

  it('says a retry is due next, not eligible to start', () => {
    expect(labels(job({ state: 'retry', retryCount: 1, startAfter: at(30), startedOn: at(-40) }))).toContain('Next attempt')
  })

  it('shows retries as a count, because only the last attempt has times', () => {
    const items = buildTimeline(job({ state: 'active', retryCount: 1, startedOn: at(-5) }), NOW)
    expect(items.map(i => i.label)).toEqual(['Created', 'Retried 1 time', 'Last attempt started', 'Finishes'])
    expect(items[1]).toMatchObject({ at: null, tone: 'retried' })
    expect(items[2].tone).toBe('live')
  })

  it('gives a running job its expiry and no deletion date', () => {
    const items = buildTimeline(job({ state: 'active', startedOn: at(-60) }), NOW)
    expect(items.at(-1)).toMatchObject({ label: 'Finishes', at: at(840) })
    expect(items.some(i => i.tone === 'retention')).toBe(false)
  })

  it('shows how long a failed last attempt ran', () => {
    const items = buildTimeline(job({ state: 'failed', retryCount: 2, startedOn: at(-42), completedOn: at(0) }), NOW)
    expect(items.find(i => i.key === 'finished')).toMatchObject({ label: 'Failed', detail: 'last attempt ran 42 s', tone: 'failed' })
  })

  it('shows how long a completed job waited and ran', () => {
    const items = buildTimeline(job({ state: 'completed', startAfter: at(-10), startedOn: at(-9.997), completedOn: at(-8.797) }), NOW)
    expect(items.find(i => i.key === 'started')!.detail).toBe('waited 3 ms')
    expect(items.find(i => i.key === 'finished')!.detail).toBe('ran 1.2 s')
  })
})

describe('statusLine', () => {
  it('describes a completed job', () => {
    const line = statusLine(job({ state: 'completed', startedOn: at(-2), completedOn: at(-0.8) }), NOW, fmt)
    expect(line).toMatch(/^Completed in 1\.2 s on the first attempt · deleted /)
  })

  it('describes a failed job by its attempts', () => {
    const line = statusLine(job({ state: 'failed', retryCount: 2, startedOn: at(-50), completedOn: at(-420) }), NOW, fmt)
    expect(line).toMatch(/^Failed 7 min ago after 3 attempts · deleted /)
  })

  it('describes a waiting job and when it is deleted if it never runs', () => {
    expect(statusLine(job({ state: 'created' }), NOW, fmt)).toMatch(/^Waiting to run · created 10 min ago · deleted .* if it never runs$/)
  })

  it('describes a retry and when it is next', () => {
    expect(statusLine(job({ state: 'retry', retryCount: 1, startAfter: at(120), startedOn: at(-40) }), NOW, fmt))
      .toMatch(/^Waiting to retry, attempt 2 of 3 · next in 2 min/)
  })
})

describe('summarizeOutput', () => {
  it('uses the message of a thrown Error and drops its stack and generic name', () => {
    expect(summarizeOutput({ name: 'Error', message: 'card declined', stack: 'Error: card declined\n    at x' }))
      .toEqual({ headline: 'card declined', details: [] })
  })

  it('keeps a specific error name', () => {
    expect(summarizeOutput({ name: 'TimeoutError', message: 'took too long' }).details)
      .toEqual([{ key: 'name', value: '"TimeoutError"' }])
  })

  it('uses an error field and shows the other small facts', () => {
    expect(summarizeOutput({ error: 'report generator timed out', after: '30s', rows: 0 })).toEqual({
      headline: 'report generator timed out',
      details: [{ key: 'after', value: '"30s"' }, { key: 'rows', value: '0' }],
    })
  })

  it("finds pg-boss's own timeout message", () => {
    expect(summarizeOutput({ value: { message: 'job timed out' } }).headline).toBe('job timed out')
  })

  it('uses a plain string as it is', () => {
    expect(summarizeOutput('boom').headline).toBe('boom')
  })

  it('has nothing to say about empty or unrecognised output', () => {
    expect(summarizeOutput(null)).toEqual({ headline: null, details: [] })
    expect(summarizeOutput({ nested: { deep: true } })).toEqual({ headline: null, details: [] })
  })
})

describe('tokenizeJson', () => {
  it('splits pretty-printed JSON into lines of typed tokens', () => {
    const lines = tokenizeJson({ to: 'a@example.com', n: 3, ok: true })
    expect(lines).toHaveLength(5)
    expect(lines[1].filter(t => t.kind !== 'punct')).toEqual([
      { text: '"to"', kind: 'key' },
      { text: '"a@example.com"', kind: 'string' },
    ])
    expect(lines[2].find(t => t.kind === 'number')!.text).toBe('3')
    expect(lines[3].find(t => t.kind === 'literal')!.text).toBe('true')
  })

  it('renders null for undefined', () => {
    expect(tokenizeJson(undefined)).toEqual([[{ text: 'null', kind: 'literal' }]])
  })
})
