import { describe, it, expect } from 'vitest'
import { showsDatabase } from '~/lib/page-scope'

describe('page scope', () => {
  const match = (handle: unknown) => ({ handle })

  it('shows the database on a page that says nothing', () => {
    expect(showsDatabase([])).toBe(true)
    expect(showsDatabase([match(undefined), match({ title: 'Queues' })])).toBe(true)
  })

  it('leaves it out under a layout about no one database', () => {
    expect(showsDatabase([match(undefined), match({ database: false }), match({ title: 'Accounts' })])).toBe(false)
  })

  it('lets a deeper route bring it back', () => {
    expect(showsDatabase([match({ database: false }), match({ database: true })])).toBe(true)
  })
})
