import assert from 'node:assert'
import * as helper from './testHelper.ts'
import { testContext } from './hooks.ts'

describe('priority', function () {
  it('higher priority job', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    await testContext.boss.send(testContext.schema)

    const high = await testContext.boss.send(testContext.schema, null, { priority: 1 })

    const [job] = await testContext.boss.fetch(testContext.schema)

    assert.strictEqual(job.id, high)
  })

  it('descending priority order', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const low = await testContext.boss.send(testContext.schema, null, { priority: 1 })
    const medium = await testContext.boss.send(testContext.schema, null, { priority: 5 })
    const high = await testContext.boss.send(testContext.schema, null, { priority: 10 })

    const [job1] = await testContext.boss.fetch(testContext.schema)
    const [job2] = await testContext.boss.fetch(testContext.schema)
    const [job3] = await testContext.boss.fetch(testContext.schema)

    assert.strictEqual(job1.id, high)
    assert.strictEqual(job2.id, medium)
    assert.strictEqual(job3.id, low)
  })

  it('bypasses priority when priority option used in fetch', async function () {
    testContext.boss = await helper.start(testContext.bossConfig)

    const low = await testContext.boss.send(testContext.schema, null, { priority: 1 })
    const medium = await testContext.boss.send(testContext.schema, null, { priority: 5 })
    const high = await testContext.boss.send(testContext.schema, null, { priority: 10 })

    const [job1] = await testContext.boss.fetch(testContext.schema, { priority: false })
    const [job2] = await testContext.boss.fetch(testContext.schema, { priority: false })
    const [job3] = await testContext.boss.fetch(testContext.schema, { priority: false })

    assert.strictEqual(job1.id, low)
    assert.strictEqual(job2.id, medium)
    assert.strictEqual(job3.id, high)
  })
})
