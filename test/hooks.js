const helper = require('./testHelper')

exports.mochaHooks = {
  beforeEach,
  afterEach
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

  const config = helper.getConfig({ testKey: getTestKey(this.currentTest) })

  const { boss } = this.currentTest

  if (boss) {
    await new Promise((resolve) => {
      boss.on('stopped', resolve)
      helper.stop(boss, 2000)
    })
  }

  await helper.dropSchema(config.schema)
}

function getTestKey (ctx) {
  return ctx.file + ctx.parent.title + ctx.title
}
