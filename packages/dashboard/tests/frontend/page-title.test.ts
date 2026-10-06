import { describe, it, expect } from 'vitest'
import { deepestTitle, documentTitle } from '~/lib/page-title'

describe('page titles', () => {
  const match = (handle: unknown, loaderData: unknown = undefined, params = {}) => ({ handle, loaderData, params })

  it('names the tab by the deepest page that has a title, its own name first', () => {
    const matches = [match({ title: 'Overview' }), match(undefined), match({ title: ({ params }: { params: { name?: string } }) => params.name ?? null }, undefined, { name: 'emails' })]

    expect(documentTitle(deepestTitle(matches), 'pg-boss Dashboard')).toBe('emails | pg-boss Dashboard')
  })

  it('reads a title from the loader data, and falls back to a parent or the app alone', () => {
    const fromData = match({ title: ({ data }: { data: { name: string } }) => data.name }, { name: 'billing' })
    const declines = match({ title: () => null })

    expect(deepestTitle([fromData])).toBe('billing')
    expect(deepestTitle([match({ title: 'Queues' }), declines])).toBe('Queues')
    expect(documentTitle(deepestTitle([match(undefined)]), 'pg-boss Dashboard')).toBe('pg-boss Dashboard')
  })

  it('asks the fallback for a page with no title of its own', () => {
    expect(deepestTitle([match({ crumb: true })], () => 'Accounts')).toBe('Accounts')
  })
})
