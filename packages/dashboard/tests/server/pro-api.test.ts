import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app')

/** The specifiers a barrel re-exports from. */
function sources (file: string): string[] {
  return [...readFileSync(join(app, file), 'utf8').matchAll(/\bfrom\s+'([^']+)'/g)].map(([, specifier]) => specifier)
}

/**
 * Pro imports the dashboard only through these three barrels. Pro's server half and its Node
 * scripts load `pro-api.ts`, which keeps React components, CSS and `.server` modules out of it.
 */
describe('the barrels Pro imports', () => {
  it('pro-api.ts re-exports only lib modules that are not .server modules', () => {
    for (const specifier of sources('lib/pro-api.ts')) {
      expect(specifier).toMatch(/^~\/lib\//)
      expect(specifier).not.toMatch(/\.server$/)
    }
  })

  it('pro-api.server.ts re-exports only .server modules', () => {
    for (const specifier of sources('lib/pro-api.server.ts')) {
      expect(specifier).toMatch(/^~\/lib\/.+\.server$/)
    }
  })

  it('pro-ui.ts re-exports no .server module', () => {
    for (const specifier of sources('components/pro-ui.ts')) {
      expect(specifier).not.toMatch(/\.server$/)
    }
  })
})
