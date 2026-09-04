import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { overlayDir, proAlias, proEnabled, proRoutes, stubPath } from '~/lib/pro-overlay'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', 'fixtures', 'pro-overlay')

function installFixture () {
  cpSync(fixture, overlayDir, { recursive: true })
}

function removeOverlay () {
  rmSync(overlayDir, { recursive: true, force: true })
}

describe('pro overlay resolution', () => {
  beforeEach(() => {
    delete process.env.PGBOSS_PRO
    removeOverlay()
  })

  afterEach(() => {
    delete process.env.PGBOSS_PRO
    removeOverlay()
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
      expect(proAlias()).toBe(stubPath)
    })

    it('adds no routes', async () => {
      await expect(proRoutes()).resolves.toEqual([])
    })

    it('ignores an overlay that is present but not asked for', async () => {
      installFixture()

      expect(proAlias()).toBe(stubPath)
      await expect(proRoutes()).resolves.toEqual([])
    })
  })

  describe('enabled without an overlay', () => {
    beforeEach(() => {
      process.env.PGBOSS_PRO = '1'
    })

    it('fails the alias with a message naming the directory', () => {
      expect(() => proAlias()).toThrow(/no overlay is present at .*app[/\\]pro/)
    })

    it('fails route resolution rather than falling back silently', async () => {
      await expect(proRoutes()).rejects.toThrow(/PGBOSS_PRO=1 but no overlay is present/)
    })
  })

  describe('enabled with an overlay', () => {
    beforeEach(() => {
      process.env.PGBOSS_PRO = '1'
      installFixture()
    })

    it('aliases ~pro to the overlay entry', () => {
      expect(proAlias()).toBe(join(overlayDir, 'index.tsx'))
      expect(existsSync(proAlias())).toBe(true)
    })

    it('appends the overlay routes', async () => {
      const routes = await proRoutes()

      expect(routes).toHaveLength(1)
      expect(routes[0]).toMatchObject({ path: 'pro-demo', file: 'pro/routes/demo.tsx' })
    })
  })
})
