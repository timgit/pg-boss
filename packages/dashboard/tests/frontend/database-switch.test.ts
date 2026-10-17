import { describe, it, expect } from 'vitest'
import { switchPathname } from '~/lib/database-switch'

describe('switchPathname', () => {
  it('keeps a page that is about no one item', () => {
    expect(switchPathname('/', {})).toBe('/')
    expect(switchPathname('/queues', {})).toBe('/queues')
    expect(switchPathname('/pro/alerts/rules', {})).toBe('/pro/alerts/rules')
  })

  it('cuts a page about one item back to its list', () => {
    expect(switchPathname('/queues/emails', { name: 'emails' })).toBe('/queues')
    expect(switchPathname('/queues/emails/metrics', { name: 'emails' })).toBe('/queues')
    expect(switchPathname('/queues/emails/jobs/0b1c', { name: 'emails', jobId: '0b1c' })).toBe('/queues')
    expect(switchPathname('/schedules/nightly/__default__', { name: 'nightly', key: '__default__' })).toBe('/schedules')
    expect(switchPathname('/pro/alerts/a1', { id: 'a1' })).toBe('/pro/alerts')
    expect(switchPathname('/pro/alerts/rules/r1/versions/2', { id: 'r1', version: '2' })).toBe('/pro/alerts/rules')
  })

  it('matches a param that needed encoding in the path', () => {
    expect(switchPathname('/queues/billing%2Finvoices', { name: 'billing/invoices' })).toBe('/queues')
    expect(switchPathname('/queues/send%20email', { name: 'send email' })).toBe('/queues')
  })

  it('never cuts at the page name, even when an item shares it', () => {
    expect(switchPathname('/queues/queues', { name: 'queues' })).toBe('/queues')
  })
})
