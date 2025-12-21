import { beforeAll, beforeEach, afterEach, expect } from 'vitest'
import * as helper from './testHelper.ts'
import type { ConstructorOptions } from '../src/types.ts'
import type { PgBoss } from '../src/index.ts'
import crypto from 'node:crypto'

export interface TestContext {
  boss?: PgBoss
  bossConfig: ConstructorOptions & { schema: string }
  schema: string
}

// Shared test context - each test file gets its own module scope in vitest
export const testContext: TestContext = {
  boss: undefined,
  bossConfig: {} as ConstructorOptions & { schema: string },
  schema: ''
}

// Track current test info for schema generation
let currentTestFile: string = ''
let currentTestName: string = ''

export function setCurrentTest (file: string, name: string): void {
  currentTestFile = file
  currentTestName = name
}

function getTestKey (): string {
  return currentTestFile + currentTestName
}

const sha1 = (value: string): string => crypto.createHash('sha1').update(value).digest('hex')

beforeAll(async () => {
  await helper.init()
})

beforeEach(async (context) => {
  // Use vitest's task info for unique schema generation
  const testFile = context.task.file?.name || 'unknown'
  const testName = context.task.name || 'unknown'
  currentTestFile = testFile
  currentTestName = testName

  const testKey = getTestKey()
  const schema = `pgboss${sha1(testKey)}`

  const config = helper.getConfig({ schema })
  console.log(`      ${testName} (schema: ${config.schema})...`)
  await helper.dropSchema(config.schema!)

  testContext.bossConfig = config as ConstructorOptions & { schema: string }
  testContext.schema = config.schema!
  testContext.boss = undefined
})

afterEach(async (context) => {
  const { boss } = testContext

  if (boss) {
    await boss.stop({ timeout: 2000 })
  }

  // Only drop schema if test passed
  const state = context.task.result?.state
  if (state === 'pass') {
    await helper.dropSchema(testContext.schema)
  }
})

// Re-export expect for convenience
export { expect }
