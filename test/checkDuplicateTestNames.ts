import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Preflight guard run once before the suite (wired as vitest `globalSetup`).
//
// Each test derives its own Postgres schema from sha1(testFile + testName) (see hooks.ts), and the
// schema doubles as the queue namespace. Two tests in the same file with the same name therefore
// collide on a single schema + queue set. They run sequentially in one shared backend (notably the
// single in-memory PGlite instance under DB_TYPE=pglite), so the collision surfaces as flaky
// cross-test interference rather than a clean failure. Reject duplicate leaf test names per file up
// front so the mistake is caught immediately instead of as an intermittent CI failure.
//
// Names only need to be unique within a file (the file path is part of the schema key), so this
// scans each test file independently. It is a static scan of `it(...)`/`test(...)` string-literal
// titles; dynamically constructed names (template interpolation, .each) are out of scope.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))

// Matches it / test (and modifiers like it.only / it.skip) whose first argument is a quoted string.
const TEST_NAME = /\b(?:it|test)(?:\.\w+)?\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g

export default function checkDuplicateTestNames (): void {
  const files = fs.readdirSync(TEST_DIR).filter(f => f.endsWith('Test.ts'))
  const offenders: string[] = []

  for (const file of files) {
    const source = fs.readFileSync(path.join(TEST_DIR, file), 'utf8')
    const counts = new Map<string, number>()
    let match: RegExpExecArray | null
    while ((match = TEST_NAME.exec(source)) !== null) {
      const name = match[2]
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    for (const [name, count] of counts) {
      if (count > 1) {
        offenders.push(`  ${file}: "${name}" (${count}x)`)
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      'Duplicate test names found. Each test name must be unique within its file because the test ' +
      'schema/queue namespace is derived from the name; duplicates collide and cause flaky ' +
      'cross-test interference.\n' + offenders.join('\n')
    )
  }
}
