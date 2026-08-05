import { itPglite } from './testHelper.ts'
import { PgBoss } from '../src/index.ts'
import { ctx } from './hooks.ts'

describe('multi-master', function () {
  itPglite('should only allow 1 master to start at a time', async function () {
    const replicaCount = 20
    const config = { ...ctx.bossConfig, supervise: true, max: 2 }
    const instances = []

    for (let i = 0; i < replicaCount; i++) {
      instances.push(new PgBoss(config))
    }

    await Promise.all(instances.map(i => i.start()))
    await Promise.all(instances.map(i => i.stop({ graceful: false })))
  })
})
