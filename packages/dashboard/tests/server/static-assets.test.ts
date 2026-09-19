import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHonoApp } from '~/server'
import type { ServerBuild } from 'react-router'

/**
 * Serving `build/client` under a base path, without serving anything else.
 *
 * The handler that strips the base path off an asset request is the only place
 * in the dashboard that turns a URL into a filesystem path, and it runs *after*
 * serveStatic's traversal guard rather than before it. That guard only rejects
 * `..` bounded by slashes, so it is not the thing keeping requests inside the
 * static root — the strip is.
 */

// A build that reports a base path, and an SSR handler that answers anything
// reaching it, so a test can tell "served a file" from "fell through".
function buildWithBasename (basename: string): ServerBuild {
  return {
    basename,
    publicPath: `${basename}/`,
    assets: { url: `${basename}/assets/manifest.js`, entry: {}, routes: {} },
    routes: {},
    entry: { module: {} },
    future: {},
    ssr: true,
    isSpaMode: false,

  } as any
}

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()

  return {
    ...actual,
    createRequestHandler: () => async () => new Response('ssr', { status: 200 }),
  }
})

describe('static assets under a base path', () => {
  const cwd = process.cwd()

  beforeEach(() => {
    // serveStatic resolves `root` against the working directory.
    process.chdir(new URL('../..', import.meta.url).pathname)
  })

  afterEach(() => {
    process.chdir(cwd)
  })

  /**
   * The escape. Thirteen characters of basename are stripped from a path whose
   * `..` is not on a segment boundary, and what is left walks out of
   * `build/client` into the server bundle beside it.
   *
   * Asserting on the status rather than the body: the file may or may not exist
   * in a given checkout, and the point is that the request must never be treated
   * as an asset lookup at all.
   */
  it('does not let a padded .. escape the static root', async () => {
    const app = createHonoApp({
      build: buildWithBasename('/admin/queues'),
      mode: 'production',
      serveStaticAssets: true,
    })

    const response = await app.request('http://localhost/aaaaaaaaaaaa../server/index.js')

    // Outside the base path: refused before any file lookup.
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found')
  })

  it('still strips the base path from a real asset request', async () => {
    const app = createHonoApp({
      build: buildWithBasename('/admin/queues'),
      mode: 'production',
      serveStaticAssets: true,
    })

    // No such file, so this falls through — but it proves the path was rewritten
    // rather than rejected, which the escape test alone cannot show.
    const response = await app.request('http://localhost/admin/queues/assets/nothing.js')

    expect(response.status).toBe(200)
  })

  /** A path that is not under the basename is not ours to rewrite. */
  it('leaves a path outside the base path alone', async () => {
    const app = createHonoApp({
      build: buildWithBasename('/admin/queues'),
      mode: 'production',
      serveStaticAssets: true,
    })

    const response = await app.request('http://localhost/elsewhere/thing.js')

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found')
  })
})
