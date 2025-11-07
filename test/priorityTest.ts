import assert from 'node:assert'
import * as helper from './testHelper.ts'

describe('priority', function () {
  it('higher priority job', async function () {
    this.boss = await helper.start(this.bossConfig) as PgBoss

    await this.boss.send(this.schema)

    const high = await this.boss.send(this.schema, null, { priority: 1 })

    const [job] = await this.boss.fetch(this.schema)

    assert.strictEqual(job.id, high)
  })

  it('descending priority order', async function () {
    this.boss = await helper.start({ ...this.bossConfig })

    const low = await this.boss.send(this.schema, null, { priority: 1 })
    const medium = await this.boss.send(this.schema, null, { priority: 5 })
    const high = await this.boss.send(this.schema, null, { priority: 10 })

    const [job1] = await this.boss.fetch(this.schema)
    const [job2] = await this.boss.fetch(this.schema)
    const [job3] = await this.boss.fetch(this.schema)

    assert.strictEqual(job1.id, high)
    assert.strictEqual(job2.id, medium)
    assert.strictEqual(job3.id, low)
  })

  it('bypasses priority when priority option used in fetch', async function () {
    this.boss = await helper.start({ ...this.bossConfig })

    const low = await this.boss.send(this.schema, null, { priority: 1 })
    const medium = await this.boss.send(this.schema, null, { priority: 5 })
    const high = await this.boss.send(this.schema, null, { priority: 10 })

    const [job1] = await this.boss.fetch(this.schema, { priority: false })
    const [job2] = await this.boss.fetch(this.schema, { priority: false })
    const [job3] = await this.boss.fetch(this.schema, { priority: false })

    assert.strictEqual(job1.id, low)
    assert.strictEqual(job2.id, medium)
    assert.strictEqual(job3.id, high)
  })
})
