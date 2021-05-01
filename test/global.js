const helper = require('./testHelper')
const delay = require('delay')

beforeEach(async function () {
  this.timeout(2000)
  const config = helper.getConfig({ testKey: getTestKey(this.currentTest) })
  console.log(`      - ${config.schema}`)
  await helper.dropSchema(config.schema)
  this.currentTest.bossConfig = config
})

afterEach(async function () {
  this.timeout(5000)

  if (this.currentTest.boss) {
    await helper.stop(this.currentTest.boss)
  }

  await delay(2000)

  const config = helper.getConfig({ testKey: getTestKey(this.currentTest) })

  await helper.dropSchema(config.schema)
})

function getTestKey (ctx) {
  return ctx.file + ctx.parent.title + ctx.title
}
