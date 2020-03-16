const helper = require('./testHelper')

beforeEach(async function () {
  this.timeout(2000)
  const config = helper.getConfig({ testKey: getTestKey(this) })
  console.log(`      - ${config.schema}`)
  await helper.dropSchema(config.schema)
  this.currentTest.bossConfig = config
})

afterEach(async function () {
  this.timeout(2000)
  const config = helper.getConfig({ testKey: getTestKey(this) })
  await helper.dropSchema(config.schema)
})

function getTestKey (ctx) {
  return ctx.currentTest.file + ctx.currentTest.parent.title + ctx.currentTest.title
}
