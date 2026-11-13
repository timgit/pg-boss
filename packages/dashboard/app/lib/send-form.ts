/**
 * The send form, read into what `boss.send()` is asked for. Pure, so the rules are testable without
 * a router or a database. Empty fields are left out, so pg-boss applies its own defaults.
 */

export type SendOptions = Record<string, unknown>

export interface SendRequest { queue: string, data: object | null, options?: SendOptions }

export type ParsedSend = { error: string } | { value: SendRequest }

type Rule = 'any' | 'nonNegative' | 'positive'

const INTEGERS: Array<[name: string, label: string, rule: Rule]> = [
  ['priority', 'Priority', 'any'],
  ['retryLimit', 'Retry limit', 'nonNegative'],
  ['expireInSeconds', 'Expire in seconds', 'positive'],
]

const KIND: Record<Rule, string> = { any: 'an integer', nonNegative: 'a non-negative integer', positive: 'a positive integer' }

function field (form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export function parseSendForm (form: FormData): ParsedSend {
  const queue = field(form, 'queueName')
  if (!queue) return { error: 'Queue name is required' }

  let data: object | null = null
  const raw = field(form, 'data')

  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { error: 'Invalid JSON in data payload' }
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: 'Data payload must be a JSON object' }
    }

    data = parsed
  }

  const options: SendOptions = {}

  for (const [name, label, rule] of INTEGERS) {
    const value = field(form, name)
    if (!value) continue

    const n = Number(value)
    const ok = Number.isInteger(n) && (rule === 'any' || (rule === 'nonNegative' ? n >= 0 : n > 0))
    if (!ok) return { error: `${label} must be ${KIND[rule]}` }

    options[name] = n
  }

  const startAfter = field(form, 'startAfter')
  if (startAfter) options.startAfter = startAfter

  const singletonKey = field(form, 'singletonKey')
  if (singletonKey) options.singletonKey = singletonKey

  return { value: { queue, data, options: Object.keys(options).length > 0 ? options : undefined } }
}
