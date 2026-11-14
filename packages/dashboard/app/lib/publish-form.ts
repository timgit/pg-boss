import { parseJobFields, type SendOptions } from './send-form'

/**
 * The publish form, read into what `boss.publish()` is asked for. Pure, so the rules are testable
 * without a router or a database. The data and options are the send form's.
 */

export interface PublishRequest { event: string, data: object | null, options?: SendOptions }

export type ParsedPublish = { error: string } | { value: PublishRequest }

export function parsePublishForm (form: FormData): ParsedPublish {
  const raw = form.get('event')
  const event = typeof raw === 'string' ? raw.trim() : ''
  if (!event) return { error: 'An event name is required' }

  const fields = parseJobFields(form)
  if ('error' in fields) return fields

  return { value: { event, ...fields } }
}
