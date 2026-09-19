import { describe, it, expect } from 'vitest'
import { createDashboardHandler } from '~/handler'

describe('createDashboardHandler', () => {
  it('needs at least one database', () => {
    expect(() => createDashboardHandler({ databases: [] })).toThrow('needs at least one database')
  })

  it('refuses two databases that would share an id', () => {
    expect(() => createDashboardHandler({
      databases: [{ url: 'postgres://one/app' }, { url: 'postgres://two/app' }],
    })).toThrow('Two databases resolve to the id "app"')
  })

  it('accepts them once they are named apart', () => {
    expect(() => createDashboardHandler({
      databases: [{ name: 'one', url: 'postgres://one/app' }, { name: 'two', url: 'postgres://two/app' }],
    })).not.toThrow()
  })

  it('rejects an unusable base path up front, not on the first request', () => {
    expect(() => createDashboardHandler({ databases: [{ url: 'postgres://host/app' }], basePath: '/a*' }))
      .toThrow('Invalid base path')
  })

  it('does not load anything until a request arrives', () => {
    // The build does not exist under test; a handler that loaded eagerly would throw here.
    expect(createDashboardHandler({ databases: [{ url: 'postgres://host/app' }] })).toBeTypeOf('function')
  })

  it('turns a failed load into a rejected request', async () => {
    // No build exists under test, so loading fails. `npm run build` is what ships one.
    const handler = createDashboardHandler({ databases: [{ url: 'postgres://host/app' }] })

    await expect(handler(new Request('http://localhost/'))).rejects.toThrow()
  })

  it('can be closed before it was ever used', async () => {
    const handler = createDashboardHandler({ databases: [{ url: 'postgres://host/app' }] })

    await expect(handler.close()).resolves.toBeUndefined()
  })
})
