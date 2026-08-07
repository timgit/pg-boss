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

interface TestFn {
  (name: string, fn: TestBody, opts?: number | TestOptions): void
  (name: string, opts: TestOptions, fn: TestBody): void
}

export interface TestAPI extends TestFn {
  skipIf: (condition: unknown) => TestAPI
  skip: TestFn
  only: TestFn
}

export type SuiteAPI = typeof describe

type PerTestSetup = (testFile: string, testName: string) => Promise<void>

let perTestSetup: PerTestSetup | undefined

export function registerPerTestSetup (fn: PerTestSetup): void {
  perTestSetup = fn
}

// Read by hooks.ts's afterEach to keep the schema of a failed (or timed-out) test for debugging.
// `seq` fences the flag: a timed-out body keeps running after bun abandons it, and without the
// fence its late resolution would mark a *later* test passed and drop a schema meant to be kept.
// Module-level state is per-file, so it survives --parallel: that flag implies --isolate, giving
// each file its own worker process (own module scope), and tests within a file still run in order.
// It would break under --concurrent (tests within one file overlapping) — the suite must not use it.
export const testState = { seq: 0, passed: false }

function callerFile (): string {
  const lines = (new Error().stack ?? '').split('\n')
  for (const line of lines) {
    // Only *.test.ts frames qualify, so a helper module that wraps `it` (testHelper's skip
    // variants, or a future one) can never become the file key for the tests it registers.
    const match = line.match(/\(?([^\s()]+\.test\.ts)[:)]/)
    if (match) {
      // Relative to cwd: running from another directory changes the schema hashes, so a failed
      // schema kept by a repo-root run is only dropped by a rerun from the same place.
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
      const seq = ++testState.seq
      testState.passed = false
      await perTestSetup(testFile, name)
      await fn()
      if (testState.seq === seq) {
        testState.passed = true
      }
    }
    if (skipped) {
      bunIt.skip(name, body, opts as never)
    } else {
      base(name, body, opts as never)
    }
  }) as TestAPI

  wrapped.skipIf = (condition: unknown) => makeIt(skipped || Boolean(condition), base)
  wrapped.skip = (name: string, a: TestBody | TestOptions, b?: TestBody | number | TestOptions) => {
    const { fn, opts } = normalizeArgs(a, b)
    bunIt.skip(name, fn, opts as never)
  }
  wrapped.only = (name: string, a: TestBody | TestOptions, b?: TestBody | number | TestOptions) =>
    makeIt(skipped, bunIt.only)(name, a as TestBody, b as never)
  return wrapped
}

export const it: TestAPI = makeIt(false)

export { describe, expect, beforeAll, beforeEach, afterEach, afterAll, vi, spyOn, expectTypeOf, setSystemTime } from 'bun:test'
