import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { overlayDir, proAlias, proEnabled, proRoutes, stubPath } from '~/lib/pro-overlay'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', 'fixtures', 'pro-overlay')

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

    it('adds no routes', async () => {
      await expect(proRoutes(missingOverlay())).resolves.toEqual([])
    })

    it('ignores an overlay that is present but not asked for', async () => {
      const dir = installFixture()

      expect(proAlias(dir)).toBe(stubPath)
      await expect(proRoutes(dir)).resolves.toEqual([])
    })
  })

  describe('enabled without an overlay', () => {
    beforeEach(() => {
      process.env.PGBOSS_PRO = '1'
    })

    it('fails the alias with a message naming the directory', () => {
      expect(() => proAlias(missingOverlay())).toThrow(/no overlay is present at .*absent/)
    })

    it('fails route resolution rather than falling back silently', async () => {
      await expect(proRoutes(missingOverlay())).rejects.toThrow(/PGBOSS_PRO=1 but no overlay is present/)
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

    it('appends the overlay routes', async () => {
      const routes = await proRoutes(installFixture())

      expect(routes).toHaveLength(1)
      expect(routes[0]).toMatchObject({ path: 'pro-demo', file: 'pro/routes/demo.tsx' })
    })

    it('leaves the real overlay directory alone', () => {
      // The suite's own footprint, asserted rather than assumed.
      const before = existsSync(overlayDir)
      installFixture()
      expect(existsSync(overlayDir)).toBe(before)
    })
  })
})
