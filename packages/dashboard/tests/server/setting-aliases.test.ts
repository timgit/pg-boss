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

  it('drops the dashboard name when only it is set', () => {
    const env: NodeJS.ProcessEnv = { PGBOSS_DASHBOARD_SITE_URL: 'https://old.example.com', PGBOSS_PRO_BASE_PATH: '' }

    applySettingAliases({ settingAliases: ALIASES }, env)

    expect(env.PGBOSS_DASHBOARD_SITE_URL).toBeUndefined()
    expect(env.PGBOSS_DASHBOARD_BASE_PATH).toBeUndefined()
  })

  it('takes the alias when both are set', () => {
    const env: NodeJS.ProcessEnv = { PGBOSS_PRO_SITE_URL: 'https://pro.example.com', PGBOSS_DASHBOARD_SITE_URL: 'https://old.example.com' }

    applySettingAliases({ settingAliases: ALIASES }, env)

    expect(env.PGBOSS_DASHBOARD_SITE_URL).toBe('https://pro.example.com')
  })

  it('changes nothing for an overlay with no aliases, as in a build without Pro', () => {
    const env: NodeJS.ProcessEnv = { PGBOSS_PRO_SITE_URL: 'https://pro.example.com', PGBOSS_DASHBOARD_SITE_URL: 'https://site.example.com' }

    applySettingAliases({}, env)

    expect(env).toEqual({ PGBOSS_PRO_SITE_URL: 'https://pro.example.com', PGBOSS_DASHBOARD_SITE_URL: 'https://site.example.com' })
  })
})
