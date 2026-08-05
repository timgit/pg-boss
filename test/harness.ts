import { it as bunIt, describe } from 'bun:test'
import path from 'node:path'

// bun:test hooks receive no test context (no file, name, or result state), so per-test schema
// setup runs inside a wrapped `it` that captures the test name at registration and the calling
// file from the stack. Teardown stays in hooks.ts's afterEach because bun still runs afterEach
// when a test times out, while the test body (and any finally inside it) is abandoned.

type TestBody = () => void | Promise<void>

interface TestOptions {
  timeout?: number
  retry?: number
  repeats?: number
}

export interface TestAPI {
  (name: string, fn: TestBody, opts?: number | TestOptions): void
  (name: string, opts: TestOptions, fn: TestBody): void
  skipIf: (condition: unknown) => TestAPI
  skip: (name: string, fn: TestBody, opts?: number | TestOptions) => void
  only: (name: string, fn: TestBody, opts?: number | TestOptions) => void
}

export type SuiteAPI = typeof describe

type PerTestSetup = (testFile: string, testName: string) => Promise<void>

let perTestSetup: PerTestSetup | undefined

export function registerPerTestSetup (fn: PerTestSetup): void {
  perTestSetup = fn
}

// Read by hooks.ts's afterEach to keep the schema of a failed (or timed-out) test for debugging.
// Module-level state is safe only under bun's sequential default — make it per-test before --parallel.
export const testState = { passed: false }

function callerFile (): string {
  const lines = (new Error().stack ?? '').split('\n')
  for (const line of lines) {
    const match = line.match(/\(?([^\s()]+\.ts)[:)]/)
    if (match && !match[1].endsWith('harness.ts') && !match[1].endsWith('testHelper.ts')) {
      return path.relative(process.cwd(), match[1])
    }
  }
  // A fallback file key would let same-named tests in different files collide on one schema, so an
  // unrecognized stack format (a path with spaces, a bun format change) must fail at registration.
  throw new Error(`harness could not resolve the calling test file from the stack:\n${lines.join('\n')}`)
}

function normalizeArgs (a: TestBody | TestOptions, b?: TestBody | number | TestOptions): { fn: TestBody, opts?: number | TestOptions } {
  if (typeof a === 'function') {
    return { fn: a, opts: b as number | TestOptions | undefined }
  }
  return { fn: b as TestBody, opts: a }
}

function makeIt (skipped: boolean, base: typeof bunIt | typeof bunIt.only = bunIt): TestAPI {
  const wrapped = ((name: string, a: TestBody | TestOptions, b?: TestBody | number | TestOptions): void => {
    const { fn, opts } = normalizeArgs(a, b)
    const testFile = callerFile()
    const body = async (): Promise<void> => {
      if (!perTestSetup) {
        throw new Error('per-test setup not registered — is test/hooks.ts preloaded via bunfig.toml?')
      }
      testState.passed = false
      await perTestSetup(testFile, name)
      await fn()
      testState.passed = true
    }
    if (skipped) {
      bunIt.skip(name, body, opts as never)
    } else {
      base(name, body, opts as never)
    }
  }) as TestAPI

  wrapped.skipIf = (condition: unknown) => makeIt(skipped || Boolean(condition), base)
  wrapped.skip = (name, fn, opts?) => bunIt.skip(name, fn, opts as never)
  wrapped.only = (name, a, b?) => makeIt(skipped, bunIt.only)(name, a as TestBody, b)
  return wrapped
}

export const it: TestAPI = makeIt(false)

export { describe, expect, beforeAll, beforeEach, afterEach, afterAll, vi, spyOn, expectTypeOf } from 'bun:test'
