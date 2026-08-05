import { beforeAll, afterEach, expect } from 'bun:test'
import * as helper from './testHelper.ts'
import { assertTruthy } from './testHelper.ts'
import { registerPerTestSetup, testState } from './harness.ts'
import type { ConstructorOptions } from '../src/types.ts'
import type { BunBoss } from '../src/index.ts'
import crypto from 'node:crypto'

export interface TestContext {
  boss?: BunBoss
  bossConfig: ConstructorOptions & { schema: string }
  schema: string
}

// Shared test context. Under bun's default single-process run every file shares this module, but
// tests execute sequentially and the harness reassigns it per test, so there is no cross-talk.
export const ctx: TestContext = {
  boss: undefined,
  bossConfig: {} as ConstructorOptions & { schema: string },
  schema: ''
}

const sha1 = (value: string): string => crypto.createHash('sha1').update(value).digest('hex')

beforeAll(async () => {
  await helper.init()
})

// Runs at the start of every wrapped test body (see harness.ts) — bun's beforeEach receives no
// test context, so the file/name pair needed for the unique schema has to come from the wrapper.
registerPerTestSetup(async (testFile, testName) => {
  const schema = `pgboss${sha1(testFile + testName)}`

  const config = helper.getConfig({ schema })
  assertTruthy(config.schema)
  console.log(`      ${testName} (schema: ${config.schema})...`)
  await helper.dropSchema(config.schema)

  ctx.bossConfig = config as ConstructorOptions & { schema: string }
  ctx.schema = config.schema
  ctx.boss = undefined
})

afterEach(async () => {
  const { boss } = ctx

  if (boss) {
    await boss.stop({ timeout: 2000 })
  }

  // Only drop schema if test passed
  if (testState.passed) {
    await helper.dropSchema(ctx.schema)
  }
})

// Re-export expect for convenience
export { expect }
