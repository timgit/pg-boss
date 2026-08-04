import EventEmitter from 'node:events'
import net, { type Server, type Socket } from 'node:net'

interface ProxyConnection {
  blackholed: boolean
  downstream: Socket
  inspection: Buffer
  listenerGeneration: number
  upstream: Socket
}

class HalfOpenProxy extends EventEmitter {
  #connections = new Set<ProxyConnection>()
  #listenerGeneration = 0
  #server: Server | null = null
  #targetHost: string
  #targetPort: number

  constructor (targetHost: string, targetPort: number) {
    super()
    this.#targetHost = targetHost
    this.#targetPort = targetPort
  }

  get listenerGeneration (): number {
    return this.#listenerGeneration
  }

  async start (): Promise<number> {
    this.#server = net.createServer(downstream => this.#accept(downstream))
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject)
      this.#server!.listen(0, '127.0.0.1', () => resolve())
    })

    const address = this.#server.address()
    if (!address || typeof address === 'string') throw new Error('Proxy did not bind a TCP port')
    return address.port
  }

  async close (): Promise<void> {
    for (const connection of this.#connections) {
      connection.downstream.destroy()
      connection.upstream.destroy()
    }
    this.#connections.clear()

    const server = this.#server
    this.#server = null
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }

  async waitForListenerAfter (generation: number, timeoutMs = 5000): Promise<ProxyConnection> {
    const current = [...this.#connections].find(connection => connection.listenerGeneration > generation)
    if (current) return current

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('listener', onListener)
        reject(new Error(`Timed out waiting for listener generation > ${generation}`))
      }, timeoutMs)
      const onListener = (connection: ProxyConnection) => {
        if (connection.listenerGeneration <= generation) return
        clearTimeout(timeout)
        this.off('listener', onListener)
        resolve(connection)
      }
      this.on('listener', onListener)
    })
  }

  blackhole (connection: ProxyConnection): void {
    if (!this.#connections.has(connection)) throw new Error('Unknown proxy connection')
    connection.blackholed = true
    connection.upstream.destroy()
  }

  #accept (downstream: Socket): void {
    const upstream = net.createConnection({ host: this.#targetHost, port: this.#targetPort })
    const connection: ProxyConnection = {
      blackholed: false,
      downstream,
      inspection: Buffer.alloc(0),
      listenerGeneration: 0,
      upstream
    }
    this.#connections.add(connection)

    downstream.on('data', chunk => {
      this.#inspect(connection, chunk)
      if (!connection.blackholed) upstream.write(chunk)
    })
    upstream.on('data', chunk => {
      if (!connection.blackholed) downstream.write(chunk)
    })
    downstream.on('error', () => upstream.destroy())
    downstream.on('close', () => {
      upstream.destroy()
      this.#connections.delete(connection)
    })
    upstream.on('error', error => {
      if (!connection.blackholed) downstream.destroy(error)
    })
    upstream.on('close', () => {
      if (!connection.blackholed) downstream.destroy()
    })
  }

  #inspect (connection: ProxyConnection, chunk: Buffer): void {
    if (connection.listenerGeneration > 0) return
    connection.inspection = Buffer.concat([connection.inspection, chunk]).subarray(-4096)
    if (!connection.inspection.toString('utf8').includes('LISTEN "')) return

    this.#listenerGeneration++
    connection.listenerGeneration = this.#listenerGeneration
    this.emit('listener', connection)
  }
}

export default HalfOpenProxy
