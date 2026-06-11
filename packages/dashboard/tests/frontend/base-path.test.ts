import { describe, it, expect } from 'vitest'
import { resolveBasePath } from '~/lib/base-path'

describe('resolveBasePath', () => {
  it.each([
    [undefined, '/', '/'],
    ['', '/', '/'],
    ['   ', '/', '/'],
    ['/', '/', '/'],
    ['/pgboss', '/pgboss', '/pgboss/'],
    ['pgboss', '/pgboss', '/pgboss/'],
    ['pgboss/', '/pgboss', '/pgboss/'],
    ['/pgboss/', '/pgboss', '/pgboss/'],
    ['//pgboss//', '/pgboss', '/pgboss/'],
    ['  /pgboss/  ', '/pgboss', '/pgboss/'],
    ['/admin/pgboss', '/admin/pgboss', '/admin/pgboss/'],
  ])('resolves %j to basename %j and base %j', (input, routerBasename, viteBase) => {
    expect(resolveBasePath(input)).toEqual({ routerBasename, viteBase })
  })

  it('keeps the Vite base trailing slash and the router basename without one', () => {
    const { routerBasename, viteBase } = resolveBasePath('/pgboss')
    expect(routerBasename.endsWith('/')).toBe(false)
    expect(viteBase.endsWith('/')).toBe(true)
  })
})
