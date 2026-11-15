import { describe, it, expect } from 'vitest'
import { showsSchema } from '~/lib/page-scope'

describe('page scope', () => {
  const match = (handle: unknown) => ({ handle })

  it('shows the schema on a page that says nothing', () => {
    expect(showsSchema([])).toBe(true)
    expect(showsSchema([match(undefined), match({ title: 'Queues' })])).toBe(true)
  })

  it('leaves it out under a layout about no one schema', () => {
    expect(showsSchema([match(undefined), match({ schema: false }), match({ title: 'Accounts' })])).toBe(false)
  })

  it('lets a deeper route bring it back', () => {
    expect(showsSchema([match({ schema: false }), match({ schema: true })])).toBe(true)
  })
})
