import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { overlayDir, proAlias, proEnabled, proRoutes, proServerAlias, stubPath, stubServerPath } from '~/lib/pro-overlay'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', 'fixtures', 'pro-overlay')

/**
 * Stand-in for the real route table. `proRoutes` returns the whole table rather
 * than the overlay's fragment, so every case has to say what it started with.
 */
const FREE_ROUTES = [
  { file: 'routes/_index.tsx' },
  { path: 'jobs', file: 'routes/jobs.tsx' },
]

/**
 * Every case passes an explicit directory this suite created under the OS temp dir.
 *
 * `overlayDir` (`app/pro`) is where a Pro build clones the real overlay — a live,
 * gitignored working tree with uncommitted work in it. This suite must never create,
 * populate, or remove that path; an earlier version did, and `npm test` silently
 * deleted the clone. Nothing below writes outside `scratch`.
 */
let scratch: string

function installFixture (): string {
  const dir = join(scratch, 'pro')
  cpSync(fixture, dir, { recursive: true })
  return dir
}

/** A path that does not exist, standing in for "flag set, overlay never cloned". */
function missingOverlay (): string {
  return join(scratch, 'absent')
}

describe('pro overlay resolution', () => {
  beforeEach(() => {
    delete process.env.PGBOSS_PRO
    scratch = mkdtempSync(join(tmpdir(), 'pgboss-pro-overlay-'))
  })

  afterEach(() => {
    delete process.env.PGBOSS_PRO
    rmSync(scratch, { recursive: true, force: true })
  })

  it('never points its own fixtures at the directory a Pro build clones into', () => {
    // Guards the invariant above: if a refactor reintroduces the default here, this
    // fails before the suite can delete somebody's overlay.
    expect(scratch.startsWith(tmpdir())).toBe(true)
    expect(installFixture()).not.toBe(overlayDir)
    expect(missingOverlay()).not.toBe(overlayDir)
  })

  describe('disabled', () => {
    it('is off unless the flag is exactly 1', () => {
      expect(proEnabled()).toBe(false)

      process.env.PGBOSS_PRO = 'true'
      expect(proEnabled()).toBe(false)

      process.env.PGBOSS_PRO = '1'
      expect(proEnabled()).toBe(true)
    })

    it('aliases ~pro to the stub', () => {
      expect(proAlias(missingOverlay())).toBe(stubPath)
    })

    it('aliases ~pro-server to the stub', () => {
      expect(proServerAlias(missingOverlay())).toBe(stubServerPath)
    })

    it('returns the free routes unchanged', async () => {
      await expect(proRoutes(FREE_ROUTES, missingOverlay())).resolves.toEqual(FREE_ROUTES)
    })

    it('ignores an overlay that is present but not asked for', async () => {
      const dir = installFixture()

      expect(proAlias(dir)).toBe(stubPath)
      expect(proServerAlias(dir)).toBe(stubServerPath)
      await expect(proRoutes(FREE_ROUTES, dir)).resolves.toEqual(FREE_ROUTES)
    })
  })

  describe('enabled without an overlay', () => {
    beforeEach(() => {
      process.env.PGBOSS_PRO = '1'
    })

    it('fails the alias with a message naming the directory', () => {
      expect(() => proAlias(missingOverlay())).toThrow(/no overlay is present at .*absent/)
    })

    it('fails the server alias too, rather than bundling the stub into a Pro build', () => {
      expect(() => proServerAlias(missingOverlay())).toThrow(/no overlay is present at .*absent/)
    })

    it('fails route resolution rather than falling back silently', async () => {
      await expect(proRoutes(FREE_ROUTES, missingOverlay())).rejects.toThrow(/PGBOSS_PRO=1 but no overlay is present/)
    })

    it('defaults to app/pro, since that is where a build looks', () => {
      // Read-only either way: this must pass on a Pro checkout that has a real
      // overlay cloned in, not only on a free one.
      if (existsSync(overlayDir)) {
        expect(proAlias()).toBe(join(overlayDir, 'index.tsx'))
      } else {
        expect(() => proAlias()).toThrow(/no overlay is present at .*app[/\\]pro/)
      }
    })
  })

  describe('enabled with an overlay', () => {
    beforeEach(() => {
      process.env.PGBOSS_PRO = '1'
    })

    it('aliases ~pro to the overlay entry', () => {
      const dir = installFixture()

      expect(proAlias(dir)).toBe(join(dir, 'index.tsx'))
      expect(existsSync(proAlias(dir))).toBe(true)
    })

    /**
     * Resolved at build time, which is the point: esbuild and tsc both see the
     * real module, so an overlay whose server half does not match
     * `ProServerOverlay` fails the Pro build rather than the customer's boot.
     */
    it('aliases ~pro-server to the overlay server entry', () => {
      const dir = installFixture()

      expect(proServerAlias(dir)).toBe(join(dir, 'server.ts'))
      expect(existsSync(proServerAlias(dir))).toBe(true)
    })

    it('keeps the two entries apart, so the Node bundle never reaches the React half', () => {
      const dir = installFixture()

      expect(proServerAlias(dir)).not.toBe(proAlias(dir))
    })

    /**
     * An overlay that adds only routes and nav — which is every overlay up to
     * this seam — has no server half to point at. Requiring one would break the
     * Pro build the day this ships.
     */
    it('falls back to the stub for an overlay with no server half', () => {
      const dir = installFixture()
      rmSync(join(dir, 'server.ts'))

      expect(proServerAlias(dir)).toBe(stubServerPath)
      expect(proAlias(dir)).toBe(join(dir, 'index.tsx'))
    })

    it('appends the overlay routes to the free ones', async () => {
      const routes = await proRoutes(FREE_ROUTES, installFixture())

      expect(routes).toHaveLength(FREE_ROUTES.length + 1)
      expect(routes.slice(0, FREE_ROUTES.length)).toEqual(FREE_ROUTES)
      expect(routes[routes.length - 1]).toMatchObject({ path: 'pro-demo', file: 'pro/routes/demo.tsx' })
    })

    /**
     * The seam RBAC needs. An overlay that only ever appended could not put
     * middleware in front of an action defined in this package, because those
     * route modules are not Pro's to edit — nesting them under a layout route
     * it does own is the only way in.
     */
    it('lets an overlay exporting a function wrap the free routes', async () => {
      const dir = installFixture()
      cpSync(join(fixture, '..', 'pro-overlay-wrapping', 'routes.ts'), join(dir, 'routes.ts'))

      const routes = await proRoutes(FREE_ROUTES, dir)

      expect(routes).toHaveLength(1)
      expect(routes[0]).toMatchObject({ file: 'pro/routes/guard.tsx' })
      expect(routes[0].children).toEqual(FREE_ROUTES)
    })

    it('leaves the real overlay directory alone', () => {
      // The suite's own footprint, asserted rather than assumed.
      const before = existsSync(overlayDir)
      installFixture()
      expect(existsSync(overlayDir)).toBe(before)
    })
  })
})
