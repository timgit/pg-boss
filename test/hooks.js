import * as helper from './testHelper'

export const mochaHooks = {
  beforeAll,
  beforeEach,
  afterEach
}

async function beforeAll () {
  await helper.init()
}

async function beforeEach () {
  this.timeout(2000)
  const config = helper.getConfig({ testKey: getTestKey(this.currentTest) })
  console.log(`      ${this.currentTest.title} (schema: ${config.schema})...`)
  await helper.dropSchema(config.schema)
  this.currentTest.bossConfig = config
}

async function afterEach () {
  this.timeout(10000)

  const { boss, state } = this.currentTest

  if (boss) {
    await boss.stop({ timeout: 2000 })
  }

  if (state === 'passed') {
    const config = helper.getConfig({ testKey: getTestKey(this.currentTest) })
    await helper.dropSchema(config.schema)
  }
}

function getTestKey (ctx) {
  return ctx.file + ctx.parent.title + ctx.title
}
