import { describe, it, expect, vi } from 'vitest'
import type { ServerBuild } from 'react-router'
import { createHonoApp } from '~/server'

const createRequestHandler = vi.hoisted(() => vi.fn(() => async () => new Response('ssr')))

vi.mock('react-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router')>(),
  createRequestHandler,
}))

const build = {
  basename: '/',
  publicPath: '/',
  assets: { url: '/assets/manifest-abc123.js', version: 'abc123', entry: { module: '/assets/entry.client-1.js', imports: [], css: [] }, routes: {} },
} as unknown as ServerBuild

describe('createHonoApp options', () => {
  it('hands the re-homed build to React Router, and keeps pages out of caches', async () => {
    const app = createHonoApp({ build, mode: 'production', basePath: '/admin/queues' })

    const res = await app.request('/admin/queues')

    expect(createRequestHandler).toHaveBeenCalledWith(expect.objectContaining({ basename: '/admin/queues' }), 'production')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
