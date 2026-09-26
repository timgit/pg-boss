// Pure helpers behind the job detail page: what to say about a job, given its row and the
// database's clock. Kept free of React so the rules (which timestamps a retry overwrites, which
// retention clause applies to which state) are testable on their own.

export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'

export interface JobTimes {
  state: JobState
  createdOn: Date | string
  startAfter: Date | string | null
  startedOn: Date | string | null
  completedOn: Date | string | null
  keepUntil: Date | string | null
  retryCount: number
  retryLimit: number
  expireInSeconds: number | null
  deleteAfterSeconds: number | null
}

export type TimelineTone = 'done' | 'pending' | 'live' | 'failed' | 'completed' | 'retried' | 'retention'

export interface TimelineItem {
  key: string
  label: string
  at: Date | null
  detail: string | null
  tone: TimelineTone
}

const FINAL_STATES: ReadonlySet<JobState> = new Set(['completed', 'cancelled', 'failed'])

export function isFinalState (state: JobState): boolean {
  return FINAL_STATES.has(state)
}

export function toDate (value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

// "3 ms", "1.2 s", "13m 48s", "1h 04m 12s", "2d 3h". Seconds are padded once minutes lead, so a
// ticking counter keeps its width. `live` drops the sub-second detail a counter that ticks once a
// second cannot show truthfully.
export function formatDuration (ms: number, { live = false }: { live?: boolean } = {}): string {
  const safe = Math.max(0, ms)
  if (live && safe < 60_000) return `${Math.floor(safe / 1000)} s`
  if (safe < 1000) return `${Math.round(safe)} ms`
  if (safe < 60_000) return `${(safe / 1000).toFixed(safe < 10_000 ? 1 : 0)} s`
  const total = Math.floor(safe / 1000)
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
  return `${minutes}m ${pad(seconds)}s`
}

// A configured interval in seconds, as a person would say it: "30 s", "15 min", "2 h", "7 days".
export function formatSeconds (seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return seconds % 60 === 0 ? `${seconds / 60} min` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
  if (seconds < 86_400) return seconds % 3600 === 0 ? `${seconds / 3600} h` : `${(seconds / 3600).toFixed(1)} h`
  const days = seconds / 86_400
  return Number.isInteger(days) ? `${days} day${days === 1 ? '' : 's'}` : `${days.toFixed(1)} days`
}

export function timeAgo (date: Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  const days = Math.floor(seconds / 86_400)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function timeUntil (date: Date, now: Date): string {
  const seconds = Math.floor((date.getTime() - now.getTime()) / 1000)
  if (seconds <= 0) return 'now'
  if (seconds < 60) return 'in under a minute'
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)} min`
  if (seconds < 86_400) return `in ${Math.floor(seconds / 3600)} h`
  const days = Math.floor(seconds / 86_400)
  return `in ${days} day${days === 1 ? '' : 's'}`
}

// Which retention clause will delete this job, and when. Core deletes a finished job at
// completed_on + deleteAfterSeconds (0 means never), and a job that never started at keep_until.
// An active job is not deleted by retention at all.
export function retention (job: JobTimes): { label: string, at: Date | null, detail: string | null } | null {
  if (job.state === 'active') return null

  if (isFinalState(job.state)) {
    const completedOn = toDate(job.completedOn)
    if (!completedOn) return null
    if (!job.deleteAfterSeconds) return { label: 'Kept', at: null, detail: 'Never deleted automatically' }
    const verb = job.state === 'failed' ? 'failing' : job.state === 'cancelled' ? 'being cancelled' : 'completing'
    return {
      label: 'Deleted',
      at: new Date(completedOn.getTime() + job.deleteAfterSeconds * 1000),
      detail: `${formatSeconds(job.deleteAfterSeconds)} after ${verb}`
    }
  }

  const keepUntil = toDate(job.keepUntil)
  return keepUntil ? { label: 'Deleted if never run', at: keepUntil, detail: null } : null
}

// When an active job's time limit runs out: started_on + expireInSeconds.
export function expiresAt (job: JobTimes): Date | null {
  const startedOn = toDate(job.startedOn)
  if (job.state !== 'active' || !startedOn || !job.expireInSeconds) return null
  return new Date(startedOn.getTime() + job.expireInSeconds * 1000)
}

// Attempts made so far. retry_count goes up when a retried job is fetched again, so a job that has
// started has had retry_count + 1 runs; one that never started has had none.
export function attempts (job: JobTimes): number {
  return toDate(job.startedOn) || isFinalState(job.state) ? job.retryCount + 1 : job.retryCount
}

// The timeline this row can support. A retry overwrites start_after, started_on and output, so
// only the latest attempt has times; earlier ones are a count and nothing more.
export function buildTimeline (job: JobTimes, now: Date): TimelineItem[] {
  const items: TimelineItem[] = []
  const createdOn = toDate(job.createdOn)
  const startAfter = toDate(job.startAfter)
  const startedOn = toDate(job.startedOn)
  const completedOn = toDate(job.completedOn)
  const retried = job.retryCount > 0

  items.push({ key: 'created', label: 'Created', at: createdOn, detail: createdOn ? timeAgo(createdOn, now) : null, tone: 'done' })

  if (retried) {
    items.push({
      key: 'retried',
      label: `Retried ${job.retryCount} time${job.retryCount === 1 ? '' : 's'}`,
      at: null,
      detail: 'Earlier attempts aren\'t recorded',
      tone: 'retried'
    })
  }

  if (job.state === 'created' || job.state === 'retry') {
    const label = job.state === 'retry' ? 'Next attempt' : 'Eligible to start'
    const immediate = startAfter && createdOn && startAfter.getTime() <= createdOn.getTime()
    items.push({
      key: 'eligible',
      label,
      at: immediate ? null : startAfter,
      detail: immediate ? 'Immediately' : (startAfter ? timeUntil(startAfter, now) : null),
      tone: startAfter && startAfter.getTime() <= now.getTime() ? 'done' : 'pending'
    })
    items.push({ key: 'started', label: 'Started', at: null, detail: 'Not yet', tone: 'pending' })
  }

  if (startedOn && job.state !== 'created' && job.state !== 'retry') {
    const waited = !retried && startAfter ? formatDuration(startedOn.getTime() - startAfter.getTime()) : null
    items.push({
      key: 'started',
      label: retried ? 'Last attempt started' : 'Started',
      at: startedOn,
      detail: job.state === 'active' ? null : (waited ? `waited ${waited}` : null),
      tone: job.state === 'active' ? 'live' : 'done'
    })
  }

  if (job.state === 'active') {
    const expiry = expiresAt(job)
    items.push({ key: 'finishes', label: 'Finishes', at: expiry, detail: expiry ? 'or it expires' : null, tone: 'pending' })
  } else if (isFinalState(job.state)) {
    const ran = startedOn && completedOn ? formatDuration(completedOn.getTime() - startedOn.getTime()) : null
    const label = job.state === 'completed' ? 'Completed' : job.state === 'failed' ? 'Failed' : 'Cancelled'
    items.push({
      key: 'finished',
      label,
      at: completedOn,
      detail: ran && job.state !== 'cancelled' ? `${retried ? 'last attempt ran' : 'ran'} ${ran}` : null,
      tone: job.state === 'completed' ? 'completed' : job.state === 'failed' ? 'failed' : 'done'
    })
  } else {
    items.push({ key: 'finished', label: 'Completed', at: null, detail: 'Not yet', tone: 'pending' })
  }

  const rule = retention(job)
  if (rule) {
    items.push({
      key: 'retention',
      label: rule.label,
      at: rule.at,
      detail: rule.detail ?? (rule.at ? timeUntil(rule.at, now) : null),
      tone: 'retention'
    })
  }

  return items
}

// The one line under the job id that says where the job stands.
export function statusLine (job: JobTimes, now: Date, fmt: (d: Date) => string): string {
  const createdOn = toDate(job.createdOn)
  const startAfter = toDate(job.startAfter)
  const startedOn = toDate(job.startedOn)
  const completedOn = toDate(job.completedOn)
  const n = attempts(job)
  const attemptText = n <= 1 ? 'on the first attempt' : `after ${n} attempts`
  const parts: string[] = []

  switch (job.state) {
    case 'created':
      parts.push(startAfter && startAfter.getTime() > now.getTime() ? `Scheduled for ${fmt(startAfter)}` : 'Waiting to run')
      if (createdOn) parts.push(`created ${timeAgo(createdOn, now)}`)
      break
    case 'retry':
      parts.push(`Waiting to retry, attempt ${job.retryCount + 1} of ${job.retryLimit + 1}`)
      if (startAfter) parts.push(startAfter.getTime() > now.getTime() ? `next ${timeUntil(startAfter, now)}` : 'due now')
      break
    case 'active':
      parts.push(n <= 1 ? 'First attempt' : `Attempt ${n} of ${job.retryLimit + 1}`)
      break
    case 'completed':
      parts.push(startedOn && completedOn
        ? `Completed in ${formatDuration(completedOn.getTime() - startedOn.getTime())} ${attemptText}`
        : 'Completed')
      break
    case 'failed':
      parts.push(completedOn ? `Failed ${timeAgo(completedOn, now)} ${attemptText}` : `Failed ${attemptText}`)
      break
    case 'cancelled':
      parts.push(completedOn ? `Cancelled ${timeAgo(completedOn, now)}` : 'Cancelled')
      break
  }

  const rule = retention(job)
  if (rule?.at) {
    parts.push(rule.label === 'Deleted if never run'
      ? `deleted ${fmt(rule.at)} if it never runs`
      : `deleted ${fmt(rule.at)}`)
  }

  return parts.join(' · ')
}

export interface OutputSummary {
  headline: string | null
  details: { key: string, value: string }[]
}

const HEADLINE_KEYS = ['message', 'error', 'reason'] as const
const HIDDEN_DETAIL_KEYS = new Set(['stack'])

// A failure's output as one readable line plus a few small facts. pg-boss stores a thrown Error as
// { message, stack, ... }, a timeout as { value: { message } }, and whatever else a handler passed
// to fail() as is, so this looks in the usual places and falls back to nothing rather than guessing.
export function summarizeOutput (output: unknown): OutputSummary {
  if (output === null || output === undefined) return { headline: null, details: [] }
  if (typeof output === 'string') return { headline: output, details: [] }
  if (typeof output !== 'object' || Array.isArray(output)) return { headline: null, details: [] }

  const record = output as Record<string, unknown>
  let headline: string | null = null
  let headlineKey: string | null = null

  for (const key of HEADLINE_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      headline = value
      headlineKey = key
      break
    }
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).message === 'string') {
      headline = (value as Record<string, string>).message
      headlineKey = key
      break
    }
  }

  if (!headline && record.value !== undefined) {
    const nested = summarizeOutput(record.value)
    if (nested.headline) return nested
  }

  // A serialized Error carries name: 'Error', which says nothing; a specific name such as
  // 'TimeoutError' still does.
  const details = Object.entries(record)
    .filter(([key, value]) => key !== headlineKey && !HIDDEN_DETAIL_KEYS.has(key) &&
      !(key === 'name' && value === 'Error') &&
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
    .slice(0, 4)
    .map(([key, value]) => ({ key, value: typeof value === 'string' ? JSON.stringify(value) : String(value) }))

  return { headline, details }
}

export interface JsonToken {
  text: string
  kind: 'key' | 'string' | 'number' | 'literal' | 'punct'
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)/g

// Pretty-printed JSON split into lines of coloured tokens, for a code block with line numbers.
export function tokenizeJson (value: unknown): JsonToken[][] {
  const text = JSON.stringify(value, null, 2) ?? 'null'
  return text.split('\n').map((line) => {
    const tokens: JsonToken[] = []
    let match: RegExpExecArray | null
    JSON_TOKEN.lastIndex = 0
    while ((match = JSON_TOKEN.exec(line)) !== null) {
      if (match[1] !== undefined) {
        tokens.push({ text: match[1], kind: match[2] ? 'key' : 'string' })
        if (match[2]) tokens.push({ text: match[2], kind: 'punct' })
      } else if (match[3] !== undefined) {
        tokens.push({ text: match[3], kind: 'number' })
      } else if (match[4] !== undefined) {
        tokens.push({ text: match[4], kind: 'literal' })
      } else {
        tokens.push({ text: match[0], kind: 'punct' })
      }
    }
    return tokens
  })
}
