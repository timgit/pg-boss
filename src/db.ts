import EventEmitter from 'node:events'
import pg from 'pg'
import assert from 'node:assert'
import type * as types from './types.ts'

// Keep silent network failures below the default 30-second notify polling backstop: in the
// worst case a failure happens immediately after a successful check, then takes one interval,
// one query timeout, and the existing first reconnect backoff (1s) to restore LISTEN.
const DEFAULT_LISTEN_HEARTBEAT_INTERVAL_MS = 10000
const DEFAULT_LISTEN_HEARTBEAT_TIMEOUT_MS = 5000
const DEFAULT_LISTEN_KEEP_ALIVE_INITIAL_DELAY_MS = 10000

class Db extends EventEmitter implements types.IDatabase, types.EventsMixin {
  private pool!: pg.Pool
  private config: types.DatabaseOptions
  /** @internal */
  readonly _pgbdb: true
  opened: boolean

  constructor (config: types.DatabaseOptions) {
    super()

    config.application_name = config.application_name || 'pgboss'
    config.connectionTimeoutMillis ??= 10000
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
  // reconnection is self-contained. TCP keepalive plus a same-session heartbeat detect silent
  // drops and lost subscriptions. The client reconnects with capped backoff, re-runs LISTEN,
  // then calls onReconnect so the caller can recover missed messages.
  async listen (
    channel: string,
    onNotification: (payload: string) => void,
    onReconnect: () => void
  ): Promise<types.ListenHandle> {
    assert(this.opened, 'Database not opened. Call open() before listening.')

    let closed = false
    let client: pg.Client | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    const heartbeatInterval = this.config.notifyHeartbeatIntervalMs ?? DEFAULT_LISTEN_HEARTBEAT_INTERVAL_MS
    const heartbeatTimeout = this.config.notifyHeartbeatTimeoutMs ?? DEFAULT_LISTEN_HEARTBEAT_TIMEOUT_MS
    const keepAliveInitialDelay = this.config.notifyKeepAliveInitialDelayMs ?? DEFAULT_LISTEN_KEEP_ALIVE_INITIAL_DELAY_MS
    // Only self-heal once the listener has been established at least once. If the INITIAL connect
    // fails, the rejection propagates to the caller (Notifier.start), which falls back to
    // polling-only and discards this subscription's close handle — so a reconnect scheduled from
    // the client 'error' handler would be an untracked connection nothing can close, keeping the
    // event loop alive and delivering notifications into a stopped manager.
    let established = false

    const clearHeartbeat = () => {
      if (!heartbeatTimer) return
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return
      const backoff = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))
      attempt++
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect().catch(() => scheduleReconnect())
      }, backoff)
    }

    const disconnect = (target: pg.Client, error: Error) => {
      if (closed || client !== target) return

      clearHeartbeat()
      client = null
      target.removeAllListeners()
      target.end().catch(() => {})
      this.emit('error', error)
      if (established) scheduleReconnect()
    }

    const scheduleHeartbeat = (target: pg.Client) => {
      if (closed || client !== target) return
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = null
        heartbeat(target).catch(error => disconnect(target, error))
      }, heartbeatInterval)
    }

    const heartbeat = async (target: pg.Client) => {
      if (closed || client !== target) return

      let timeout: ReturnType<typeof setTimeout> | null = null
      const query = target.query(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_listening_channels() AS active(channel)
            WHERE channel = $1
         ) AS listening`,
        [channel]
      )
      query.catch(() => {})

      try {
        const result = await Promise.race([
          query,
          new Promise<never>((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('LISTEN/NOTIFY heartbeat timed out')), heartbeatTimeout)
          })
        ])

        if (!result.rows[0]?.listening) {
          throw new Error('LISTEN/NOTIFY channel registration was lost')
        }
      } finally {
        if (timeout) clearTimeout(timeout)
      }

      scheduleHeartbeat(target)
    }

    const connect = async () => {
      if (closed) return

      const next = new pg.Client({
        ...this.config,
        keepAlive: true,
        keepAliveInitialDelayMillis: keepAliveInitialDelay
      })

      next.on('error', error => {
        disconnect(next, error)
      })

      next.on('end', () => disconnect(next, new Error('LISTEN/NOTIFY connection ended')))

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
      established = true
      scheduleHeartbeat(next)
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
        clearHeartbeat()
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
