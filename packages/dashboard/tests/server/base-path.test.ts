import { describe, it, expect } from 'vitest'
import { resolveBasePath, stripBasePrefix } from '~/lib/base-path'

/**
 * The two pure functions that decide where the dashboard lives.
 *
 * Tested here as functions rather than through an HTTP request, because at the
 * HTTP level a refusal by `stripBasePrefix` and a refusal by the static
 * middleware look identical. The first version of `static-assets.test.ts`
 * asserted the traversal property through `app.request()` and passed with the
 * vulnerable `slice` restored — the middleware was catching the payloads, and
 * the test could not tell. These cannot go quiet the same way: there is nothing
 * else in the call.
 */

describe('stripBasePrefix', () => {
  const BASENAME = '/admin/queues'

  it('removes the prefix on a segment boundary', () => {
    expect(stripBasePrefix('/admin/queues/assets/app.js', BASENAME)).toBe('/assets/app.js')
  })

  it('maps the bare mount path to the root', () => {
    expect(stripBasePrefix('/admin/queues', BASENAME)).toBe('/')
  })

  it('leaves a path that is not under the prefix alone', () => {
    expect(stripBasePrefix('/elsewhere/app.js', BASENAME)).toBe('/elsewhere/app.js')
  })

  /**
   * The bug this function exists for.
   *
   * A blind `slice(basename.length)` on any of these leaves a path beginning
   * `..`, which resolves out of `build/client` and into the server bundle beside
   * it. The shared prefix is what gets past serveStatic's own guard, so the only
   * thing that can refuse them is the segment-boundary check here.
   */
  const escapes = [
    '/aaaaaaaaaaaa../server/index.js',
    '/admin/queue../server/index.js',
    '/admin/queuesX../server/index.js',
    '/admin/queues../server/index.js',
    '/admin/queuesetc/passwd',
  ]

  it.each(escapes)('never returns a path that escapes the root: %s', (path) => {
    const result = stripBasePrefix(path, BASENAME)

    // Returned unchanged, because none of these is under the mount path. The
    // assertion is on the property rather than on equality with the input, so it
    // still means something if the "not ours" branch ever starts normalising.
    expect(result.startsWith('..')).toBe(false)
    expect(result.split('/')).not.toContain('..')
    expect(result).toBe(path)
  })

  it('is a no-op without a basename', () => {
    expect(stripBasePrefix('/assets/app.js', '')).toBe('/assets/app.js')
    expect(stripBasePrefix('/assets/app.js', '/')).toBe('/assets/app.js')
  })
})

describe('resolveBasePath', () => {
  it('treats absent, empty and root as the root path', () => {
    for (const raw of [undefined, '', '   ', '/']) {
      expect(resolveBasePath(raw)).toEqual({ routerBasename: '/', viteBase: '/' })
    }
  })

  it('derives both forms from one value', () => {
    expect(resolveBasePath('/pgboss')).toEqual({ routerBasename: '/pgboss', viteBase: '/pgboss/' })
    expect(resolveBasePath('pgboss')).toEqual({ routerBasename: '/pgboss', viteBase: '/pgboss/' })
    expect(resolveBasePath('/pgboss/')).toEqual({ routerBasename: '/pgboss', viteBase: '/pgboss/' })
  })

  /**
   * A `viteBase` of `//` makes every asset URL protocol-relative: the browser
   * reads `//assets/app.js` as a host named `assets` and fetches off the box.
   * Only reachable since the base path became a runtime value.
   */
  it('never produces a protocol-relative base', () => {
    for (const raw of ['//', '///', '   ///   ', '/////']) {
      const { viteBase, routerBasename } = resolveBasePath(raw)

      expect(viteBase.startsWith('//')).toBe(false)
      expect(viteBase).toBe('/')
      expect(routerBasename).toBe('/')
    }
  })

  /** An interior `//` is refused by serveStatic, so every asset 404s. */
  it('collapses interior slash runs', () => {
    expect(resolveBasePath('/a//b')).toEqual({ routerBasename: '/a/b', viteBase: '/a/b/' })
    expect(resolveBasePath('//admin///queues//')).toEqual({
      routerBasename: '/admin/queues',
      viteBase: '/admin/queues/',
    })
  })
})
