import { describe, it, expect } from 'vitest'
import type { ServerBuild } from 'react-router'
import { rehomeAssetUrls, renderManifestSource, withBasePath } from '~/lib/runtime-base-path'

const manifest = {
  url: '/assets/manifest-abc123.js',
  version: 'abc123',
  entry: { module: '/assets/entry.client-1.js', imports: ['/assets/react-2.js'], css: [] },
  routes: {
    root: { id: 'root', path: '', module: '/assets/root-3.js', imports: ['/assets/react-2.js'], css: ['/assets/root-4.css'] },
    'routes/assets': { id: 'routes/assets', path: 'assets', module: '/assets/assets-5.js', imports: [], css: [] },
  },
}

const build = { basename: '/', publicPath: '/', assets: manifest } as unknown as ServerBuild

describe('withBasePath', () => {
  it('returns the build untouched when no base path is given', () => {
    expect(withBasePath(build, undefined)).toBe(build)
  })

  it('returns the build untouched when the base path is the one it was built with', () => {
    expect(withBasePath(build, '/')).toBe(build)
  })

  it('sets the basename and public path and re-homes every asset URL', () => {
    const rehomed = withBasePath(build, 'admin/queues/')

    expect(rehomed.basename).toBe('/admin/queues')
    expect(rehomed.publicPath).toBe('/admin/queues/')
    expect(rehomed.assets.url).toBe('/admin/queues/assets/manifest-abc123.js')
    expect(rehomed.assets.entry.module).toBe('/admin/queues/assets/entry.client-1.js')
    expect(rehomed.assets.entry.imports).toEqual(['/admin/queues/assets/react-2.js'])
    expect(rehomed.assets.routes.root?.css).toEqual(['/admin/queues/assets/root-4.css'])
  })

  it('leaves everything that is not an asset URL alone', () => {
    const rehomed = withBasePath(build, '/admin')

    expect(rehomed.assets.version).toBe('abc123')
    expect(rehomed.assets.routes['routes/assets']?.path).toBe('assets')
    expect(rehomed.assets.routes['routes/assets']?.id).toBe('routes/assets')
  })

  it('does not mutate the original build', () => {
    withBasePath(build, '/admin')

    expect(build.basename).toBe('/')
    expect(build.assets.entry.module).toBe('/assets/entry.client-1.js')
  })

  it('replaces a base path baked at build time', () => {
    const baked = withBasePath(build, '/baked')
    const rehomed = withBasePath(baked, '/runtime')

    expect(rehomed.basename).toBe('/runtime')
    expect(rehomed.assets.entry.module).toBe('/runtime/assets/entry.client-1.js')
  })

  it('can bring a build baked under a base path back to the root', () => {
    const rehomed = withBasePath(withBasePath(build, '/baked'), '/')

    expect(rehomed.basename).toBe('/')
    expect(rehomed.assets.entry.module).toBe('/assets/entry.client-1.js')
  })

  it.each(['/a:b', '/a*', '/a b', '/a?x', '/{a}'])('rejects %s, which would be read as a route pattern', (basePath) => {
    expect(() => withBasePath(build, basePath)).toThrow('Invalid base path')
  })
})

describe('rehomeAssetUrls', () => {
  it('only rewrites strings that start with the public asset path', () => {
    expect(rehomeAssetUrls(['/assets/a.js', 'see /assets/a.js', '/other/assets/a.js'], '/', '/x/'))
      .toEqual(['/x/assets/a.js', 'see /assets/a.js', '/other/assets/a.js'])
  })
})

describe('renderManifestSource', () => {
  it('serializes the manifest the way the static manifest file does', () => {
    expect(renderManifestSource(withBasePath(build, '/x')))
      .toBe(`window.__reactRouterManifest=${JSON.stringify(withBasePath(build, '/x').assets)};`)
  })
})
