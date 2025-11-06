import * as helper from './testHelper.ts'
import type { Context, Test } from 'mocha'
import type { ConstructorOptions } from '../src/types.ts'

export type { Context as TestContext }

export const mochaHooks = {
  beforeAll,
  beforeEach,
  afterEach
}

async function beforeAll (this: Context): Promise<void> {
  await helper.init()
}

async function beforeEach (this: Context): Promise<void> {
  this.timeout(2000)
  const config = helper.getConfig({ testKey: getTestKey(this.currentTest!) })
  console.log(`      ${this.currentTest!.title} (schema: ${config.schema})...`)
  await helper.dropSchema(config.schema!)

  // Set properties directly on context for easy access in tests
  this.bossConfig = config as ConstructorOptions & { schema: string }
  this.schema = config.schema!
}

async function afterEach (this: Context): Promise<void> {
  this.timeout(10000)

  const { boss } = this.currentTest!.ctx!

  if (boss) {
    await boss.stop({ timeout: 2000 })
  }

  if (this.currentTest!.state === 'passed') {
    await helper.dropSchema(this.schema)
  }
}

function getTestKey (ctx: Test): string {
  return ctx.file! + ctx.parent!.title + ctx.title
}
