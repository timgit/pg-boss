import EventEmitter from 'node:events'
import pg from 'pg'
import assert from 'node:assert'
import type * as types from './types.ts'

class Db extends EventEmitter implements types.IDatabase, types.EventsMixin {
  private pool!: pg.Pool
  private config: types.DatabaseOptions
  /** @internal */
  readonly _pgbdb: true
  opened: boolean

  constructor (config: types.DatabaseOptions) {
    super()

    config.application_name = config.application_name || 'pgboss'
    config.connectionTimeoutMillis = config.connectionTimeoutMillis || 10000
    // config.maxUses = config.maxUses || 1000

    this.config = config
    this._pgbdb = true
    this.opened = false
  }

  events = {
    error: 'error'
  }

  async open () {
    this.pool = new pg.Pool(this.config)
    this.pool.on('error', error => this.emit('error', error))
    this.opened = true
  }

  async close () {
    if (!this.pool.ending) {
      this.opened = false
      await this.pool.end()
    }
  }

  async executeSql (text: string, values?: unknown[]) {
    assert(this.opened, 'Database not opened. Call open() before executing SQL.')

    // if (this.config.debug === true) {
    //   console.log(`${new Date().toISOString()}: DEBUG SQL`)
    //   console.log(text)

    //   if (values) {
    //     console.log(`${new Date().toISOString()}: DEBUG VALUES`)
    //     console.log(values)
    //   }
    // }

    return await this.pool.query(text, values)
  }

  // Opens a dedicated, session-pinned connection for LISTEN/NOTIFY. A separate pg.Client
  // (not a pooled connection) is used so the listener never depletes the query pool and so
  // reconnection is self-contained. On any drop the client reconnects with capped backoff
  // and re-runs LISTEN, then calls onReconnect so the caller can recover missed messages.
  async listen (
    channel: string,
    onNotification: (payload: string) => void,
    onReconnect: () => void
  ): Promise<types.ListenHandle> {
    assert(this.opened, 'Database not opened. Call open() before listening.')

    let closed = false
    let client: pg.Client | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return
      const backoff = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))
      attempt++
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect().catch(() => scheduleReconnect())
      }, backoff)
    }

    const connect = async () => {
      if (closed) return

      const next = new pg.Client(this.config)

      next.on('error', error => {
        this.emit('error', error)
        if (!closed) {
          next.removeAllListeners()
          next.end().catch(() => {})
          if (client === next) client = null
          scheduleReconnect()
        }
      })

      next.on('notification', msg => {
        if (msg.payload !== undefined) onNotification(msg.payload)
      })

      // Track the client before connecting so close() can tear down a connect still in flight
      // (e.g. shutdown during a reconnect). If connect or LISTEN then rejects, the catch ends
      // it and rethrows — without that, a LISTEN that fails after connect() succeeded would
      // leak an open connection. The reconnect .catch below reschedules on failure; an initial
      // failure propagates to the caller.
      client = next

      try {
        await next.connect()
        await next.query(`LISTEN "${channel}"`)
      } catch (err) {
        next.removeAllListeners()
        await next.end().catch(() => {})
        if (client === next) client = null
        throw err
      }

      attempt = 0
      onReconnect()
    }

    await connect()

    return {
      close: async () => {
        closed = true
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
        if (client) {
          client.removeAllListeners()
          await client.end().catch(() => {})
          client = null
        }
      }
    }
  }

  async withTransaction<T> (fn: (db: types.IDatabase) => Promise<T>): Promise<T> {
    assert(this.opened, 'Database not opened. Call open() before executing SQL.')

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const txDb: types.IDatabase = {
        executeSql: (text: string, values?: unknown[]) => client.query(text, values)
      }
      const result = await fn(txDb)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}

export default Db
