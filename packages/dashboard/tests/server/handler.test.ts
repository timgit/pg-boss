import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDashboardHandler } from '~/handler'

describe('createDashboardHandler', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

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

  it('says when PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS is set, since only the option applies', () => {
    vi.stubEnv('PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS', 'admin.example.com')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    createDashboardHandler({ databases: [{ url: 'postgres://host/app' }] })

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS ignored/))
  })

  it('stays quiet about the variable when the option is passed or the value lists nothing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    vi.stubEnv('PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS', 'admin.example.com')
    createDashboardHandler({ databases: [{ url: 'postgres://host/app' }], allowedActionOrigins: ['admin.example.com'] })
    vi.stubEnv('PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS', ' , ')
    createDashboardHandler({ databases: [{ url: 'postgres://host/app' }] })

    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/PGBOSS_DASHBOARD_ALLOWED_ACTION_ORIGINS ignored/))
  })

  it('rejects a bad allowedActionOrigins value up front, not on the first request', () => {
    expect(() => createDashboardHandler({ databases: [{ url: 'postgres://host/app' }], allowedActionOrigins: ['*.com'] }))
      .toThrow('allowedActionOrigins entry "*.com" matches too many hosts')
    expect(() => createDashboardHandler({ databases: [{ url: 'postgres://host/app' }], allowedActionOrigins: null as never }))
      .toThrow('allowedActionOrigins must be an array of host strings')
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

  it('answers 503 once closed, instead of loading or writing again', async () => {
    const handler = createDashboardHandler({ databases: [{ url: 'postgres://host/app' }] })
    await handler.close()

    const res = await handler(new Request('http://localhost/'))

    expect(res.status).toBe(503)
  })

  it('can be closed before it was ever used', async () => {
    const handler = createDashboardHandler({ databases: [{ url: 'postgres://host/app' }] })

    await expect(handler.close()).resolves.toBeUndefined()
  })
})
