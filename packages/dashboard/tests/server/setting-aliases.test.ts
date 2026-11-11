import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySettingAliases } from '~/lib/server-overlay'

const ALIASES = { PGBOSS_PRO_SITE_URL: 'PGBOSS_DASHBOARD_SITE_URL', PGBOSS_PRO_BASE_PATH: 'PGBOSS_DASHBOARD_BASE_PATH' }

describe('applySettingAliases', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('puts a set alias in place of the dashboard setting it names', () => {
    const env: NodeJS.ProcessEnv = { PGBOSS_PRO_SITE_URL: 'https://pro.example.com' }

    applySettingAliases({ settingAliases: ALIASES }, env)

    expect(env.PGBOSS_DASHBOARD_SITE_URL).toBe('https://pro.example.com')
    expect(env.PGBOSS_DASHBOARD_BASE_PATH).toBeUndefined()
  })

  it('leaves the dashboard name working when the alias is unset or empty', () => {
    const env: NodeJS.ProcessEnv = { PGBOSS_DASHBOARD_SITE_URL: 'https://old.example.com', PGBOSS_PRO_BASE_PATH: '' }

    applySettingAliases({ settingAliases: ALIASES }, env)

    expect(env.PGBOSS_DASHBOARD_SITE_URL).toBe('https://old.example.com')
    expect(env.PGBOSS_DASHBOARD_BASE_PATH).toBeUndefined()
  })

  it('takes the alias when both are set, and warns only when they differ', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env: NodeJS.ProcessEnv = { PGBOSS_PRO_SITE_URL: 'https://pro.example.com', PGBOSS_DASHBOARD_SITE_URL: 'https://old.example.com' }

    applySettingAliases({ settingAliases: ALIASES }, env)

    expect(env.PGBOSS_DASHBOARD_SITE_URL).toBe('https://pro.example.com')
    expect(warn).toHaveBeenCalledWith('PGBOSS_PRO_SITE_URL and PGBOSS_DASHBOARD_SITE_URL are both set, to different values. Using PGBOSS_PRO_SITE_URL.')

    warn.mockClear()
    applySettingAliases({ settingAliases: ALIASES }, env)
    expect(warn).not.toHaveBeenCalled()
  })

  it('changes nothing for an overlay with no aliases, as in a free build', () => {
    const env: NodeJS.ProcessEnv = { PGBOSS_PRO_SITE_URL: 'https://pro.example.com' }

    applySettingAliases({}, env)

    expect(env).toEqual({ PGBOSS_PRO_SITE_URL: 'https://pro.example.com' })
  })
})
