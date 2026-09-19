import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerBuild } from 'react-router'
import { createHonoApp } from '~/server'

// Enough of a build for the routes registered ahead of the React Router handler.
const build = {
  basename: '/',
  publicPath: '/',
  assets: {
    url: '/assets/manifest-abc123.js',
    version: 'abc123',
    entry: { module: '/assets/entry.client-1.js', imports: [], css: [] },
    routes: {},
  },
} as unknown as ServerBuild

describe('createHonoApp under a runtime base path', () => {
  const originalEnv = { ...process.env }
  let clientRoot: string

  beforeEach(async () => {
    delete process.env.PGBOSS_DASHBOARD_AUTH_USERNAME
    delete process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD

    clientRoot = await mkdtemp(join(tmpdir(), 'pgboss-dashboard-'))
    await mkdir(join(clientRoot, 'assets'))
    await writeFile(join(clientRoot, 'assets', 'entry.client-1.js'), 'console.log("entry")')
    await writeFile(join(clientRoot, 'assets', 'manifest-abc123.js'), 'window.__reactRouterManifest={"baked":"/assets/"};')
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    await rm(clientRoot, { recursive: true, force: true })
  })

  const createApp = () => createHonoApp({
    build, mode: 'production', serveStaticAssets: true, clientRoot, basePath: '/admin/queues',
  })

  it('serves the manifest with its asset URLs under the base path', async () => {
    const res = await createApp().request('/admin/queues/assets/manifest-abc123.js')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')

    const source = await res.text()
    expect(source).toContain('"/admin/queues/assets/entry.client-1.js"')
    expect(source).not.toContain('"/assets/')
  })

  it('serves the other assets from the client root, under the base path', async () => {
    const res = await createApp().request('/admin/queues/assets/entry.client-1.js')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('console.log("entry")')
  })

  it('keeps the manifest behind basic auth', async () => {
    process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = 'admin'
    process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = 'secret'

    const res = await createApp().request('/admin/queues/assets/manifest-abc123.js')

    expect(res.status).toBe(401)
  })

  it('leaves the baked manifest alone without a runtime base path', async () => {
    const app = createHonoApp({ build, mode: 'production', serveStaticAssets: true, clientRoot })
    const res = await app.request('/assets/manifest-abc123.js')

    expect(await res.text()).toBe('window.__reactRouterManifest={"baked":"/assets/"};')
  })
})
