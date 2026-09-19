import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
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
 *
 * Two mechanisms now protect this, and they are tested separately on purpose.
 * The mount-path guard refuses anything outside the base path before a file is
 * looked up at all; the strip keeps what remains inside the root. Either one
 * alone stops every payload below, which is why neither may be asserted through
 * the other: a test that only pins the status passes with the strip reverted,
 * and a test that only pins the body passes with the guard removed.
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

const BASENAME = '/admin/queues'

/**
 * A marker that really is in the file an escape would reach, checked here rather
 * than assumed.
 *
 * The previous version of this test asserted the body did not contain
 * `createHonoApp` or `serveStatic`. Neither string appears in
 * `build/server/index.js` — that bundle is the *route* build — so the assertion
 * could never have failed and the test was pinning nothing but the status. Read
 * the first bytes of the target instead, and skip the body check when the file
 * is absent rather than quietly passing on a substring that is never there.
 */
function serverBundleMarker (): string | null {
  try {
    return readFileSync(new URL('../../build/server/index.js', import.meta.url), 'utf8').slice(0, 120)
  } catch {
    return null
  }
}

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
   * Shapes that have to stay outside `build/client`.
   *
   * The padded `..` is the original bug: thirteen characters of basename are
   * stripped from a path whose `..` is not on a segment boundary, and what is
   * left walks out of `build/client` into the server bundle beside it. The rest
   * are the encodings a scanner tries next, including the ones that only become
   * `..` after the strip has already run.
   */
  const escapes = [
    ['padded .., the original bug', '/aaaaaaaaaaaa../server/index.js'],
    ['plain traversal', '/../server/index.js'],
    ['traversal inside the base path', `${BASENAME}/../../server/index.js`],
    ['doubled traversal', `${BASENAME}/../../../packages/dashboard/build/server/index.js`],
    ['encoded dots', `${BASENAME}/%2e%2e/%2e%2e/server/index.js`],
    ['double-encoded dots', `${BASENAME}/%252e%252e/server/index.js`],
    ['encoded slash', `${BASENAME}/..%2f..%2fserver/index.js`],
    ['backslash separator', `${BASENAME}\\..\\..\\server\\index.js`],
    ['encoded backslash', `${BASENAME}/..%5c..%5cserver/index.js`],
    ['overlong dot', `${BASENAME}/%c0%ae%c0%ae/server/index.js`],
    ['dot-semicolon', `${BASENAME}/..;/server/index.js`],
    ['four-dot slash', `${BASENAME}/....//server/index.js`],
    ['trailing null', `${BASENAME}/../server/index.js%00.css`],
  ] as const

  it.each(escapes)('never serves a file outside the static root: %s', async (_label, path) => {
    const app = createHonoApp({
      build: buildWithBasename(BASENAME),
      mode: 'production',
      serveStaticAssets: true,
    })

    const response = await app.request(`http://localhost${path}`)
    const body = await response.text()
    const marker = serverBundleMarker()

    // The property, asserted directly: whatever came back, it is not the file
    // sitting outside the root. Independent of which mechanism refused it.
    expect(response.headers.get('content-type') ?? '').not.toMatch(/javascript/)

    if (marker) {
      expect(body).not.toContain(marker)
    }

    // And nothing here may be answered as a file at all.
    expect([200, 404]).toContain(response.status)

    if (response.status === 200) {
      // The only legitimate 200 is the mocked SSR handler.
      expect(body).toBe('ssr')
    }
  })

  /**
   * The mount-path guard, pinned on its own.
   *
   * Asserting the exact 404 body rather than only the status: a status alone
   * would also be satisfied by a missing file falling through to a router 404,
   * which is a different refusal.
   */
  it('refuses a path outside the base path before any file lookup', async () => {
    const app = createHonoApp({
      build: buildWithBasename(BASENAME),
      mode: 'production',
      serveStaticAssets: true,
    })

    const response = await app.request('http://localhost/aaaaaaaaaaaa../server/index.js')

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found')
  })

  it('still strips the base path from a real asset request', async () => {
    const app = createHonoApp({
      build: buildWithBasename(BASENAME),
      mode: 'production',
      serveStaticAssets: true,
    })

    // No such file, so this falls through — but it proves the path was rewritten
    // rather than rejected, which the escape test alone cannot show.
    const response = await app.request(`http://localhost${BASENAME}/assets/nothing.js`)

    expect(response.status).toBe(200)
  })

  /** A path that is not under the basename is not ours to rewrite. */
  it('leaves a path outside the base path alone', async () => {
    const app = createHonoApp({
      build: buildWithBasename(BASENAME),
      mode: 'production',
      serveStaticAssets: true,
    })

    const response = await app.request('http://localhost/elsewhere/thing.js')

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found')
  })

  /**
   * With no base path there is no strip and no mount guard, so serveStatic's own
   * traversal handling is all there is. Pinned because "the dashboard at the
   * root path" is the default deployment.
   */
  it('never serves a file outside the static root without a base path', async () => {
    const app = createHonoApp({
      build: buildWithBasename('/'),
      mode: 'production',
      serveStaticAssets: true,
    })

    const marker = serverBundleMarker()

    for (const [, path] of escapes) {
      const response = await app.request(`http://localhost${path}`)
      const body = await response.text()

      expect(response.headers.get('content-type') ?? '').not.toMatch(/javascript/)

      if (marker) {
        expect(body).not.toContain(marker)
      }
    }
  })
})
