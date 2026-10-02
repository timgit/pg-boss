import net from 'node:net'
import { expect } from 'vitest'
import { PgBoss } from '../src/index.ts'
import * as helper from './testHelper.ts'
import { ctx } from './hooks.ts'

/**
 * A TCP relay in front of the test database that can be taken down and brought back on the same port,
 * which is how an outage looks to a client: connections refused, and the open ones cut.
 */
async function databaseRelay (host: string, port: number) {
  const sockets = new Set<net.Socket>()
  let server: net.Server | null = null
  let relayPort = 0

  const up = () => new Promise<void>((resolve, reject) => {
    if (server) return resolve()
    server = net.createServer(client => {
      const upstream = net.connect(port, host)
      for (const socket of [client, upstream]) {
        sockets.add(socket)
        socket.on('error', () => {})
        socket.on('close', () => sockets.delete(socket))
      }
      client.pipe(upstream)
      upstream.pipe(client)
    })
    server.once('error', reject)
    server.listen(relayPort, '127.0.0.1', () => {
      relayPort = (server!.address() as net.AddressInfo).port
      resolve()
    })
  })

  const down = () => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (server) server.close(() => resolve())
    else resolve()
    server = null
  })

  // Claim a port, then take the relay down so it starts out unreachable on that port.
  await up()
  await down()

  return { port: relayPort, up, down }
}

describe('database', function () {
  it('should fail on invalid database host', async function () {
    const boss = new PgBoss({
      connectionString: 'postgres://bobby:tables@wat:12345/northwind',
      connectionTimeoutMillis: 3000
    })

    await expect(async () => {
      await boss.start()
    }).rejects.toThrow()
  })

  // A pool pg-boss opens itself; a db adapter passed in (PGlite here) is the caller's to open.
  helper.itPglite('refuses work before start(), naming start() in the error', async function () {
    const boss = new PgBoss(helper.getConfig())
    const message = 'Call start() before using pg-boss'

    await expect(boss.send('queue')).rejects.toThrow(message)
    await expect(boss.createQueue('queue')).rejects.toThrow(message)
    await expect(boss.fetch('queue')).rejects.toThrow(message)
    await expect(boss.getQueues()).rejects.toThrow(message)
  })

  // Over TCP, so not PGlite. https://github.com/timgit/pg-boss/issues/510
  helper.itPglite('recovers when the database is down at start(), and when it drops while running', async function () {
    const relay = await databaseRelay(ctx.bossConfig.host!, Number(ctx.bossConfig.port))
    const boss = new PgBoss({ ...ctx.bossConfig, host: '127.0.0.1', port: relay.port, connectionTimeoutMillis: 1000 })
    let errors = 0
    boss.on('error', () => { errors++ })
    const handled: string[] = []

    try {
      // Down at startup: start() fails, and a worker can still be registered for later.
      await expect(boss.start()).rejects.toThrow()
      await boss.work(ctx.schema, { pollingIntervalSeconds: 0.5 }, async ([job]) => { handled.push(job.id) })

      // Back: start() again on the same instance, and the early worker takes jobs.
      await relay.up()
      await boss.start()
      await boss.createQueue(ctx.schema)
      const first = await boss.send(ctx.schema)
      await helper.until(() => handled.includes(first!), 10_000)

      // Drops while running: the worker reports errors, then resumes once the database is back.
      errors = 0
      await relay.down()
      await helper.until(() => errors > 0, 10_000)
      await relay.up()
      const second = await boss.send(ctx.schema)
      await helper.until(() => handled.includes(second!), 10_000)
    } finally {
      await relay.up()
      await boss.stop({ graceful: false, timeout: 2000 }).catch(() => {})
      await relay.down()
    }
  })

  helper.itPglite('applies session statements to an open pool, and refuses when one is in use', async function () {
    const db = await helper.getDb()
    const statements = ["SET application_name = 'pgboss_session_statements_test'"]

    try {
      // Nothing is checked out during start(), which is the only time pg-boss sets these on an open
      // pool - so the set can be made total there and the sweep below is what makes it so.
      await db.executeSql('SELECT 1')
      await db.setSessionStatements(statements)

      const { rows } = await db.executeSql('SHOW application_name')
      expect(rows[0].application_name).toBe('pgboss_session_statements_test')

      // @ts-ignore reaching the pool, the way the pool-lifecycle tests do
      const held = await db.pool.connect()

      try {
        // A connection someone else holds cannot be reached, so the set would land on some sessions
        // and not others. Refused rather than applied in half.
        await expect(db.setSessionStatements(statements)).rejects.toThrow('already checked out')

        // Clearing is safe whatever is checked out: it only stops stamping connections opened
        // later, and the statements it would have run are the ones already applied.
        await db.setSessionStatements([])
      } finally {
        held.release()
      }
    } finally {
      await db.close()
    }
  })

  it('can be swapped out via BYODB', async function () {
    const query = 'SELECT something FROM somewhere'

    const mydb = {
      executeSql: async (text: string, values: []): Promise<{ rows: any[]; text: string }> => {
        expect(text).toBe(query)
        return { rows: [], text }
      }
    }

    const boss = new PgBoss({ db: mydb })
    const response = await boss.getDb().executeSql(query)

    // @ts-ignore
    expect(response.text).toBe(query)
  })
})
