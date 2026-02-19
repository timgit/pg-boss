import { createProxyServerNode } from './node.js'
import { configure, getConsoleSink, getLogger } from '@logtape/logtape'

await configure({
  sinks: { console: getConsoleSink() },
  loggers: [
    { category: ['pg-boss', 'proxy'], lowestLevel: 'info', sinks: ['console'] },
    { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: ['console'] }
  ]
})

const logger = getLogger(['pg-boss', 'proxy'])
const proxy = createProxyServerNode()

try {
  const info = await proxy.start()
  logger.info(`pg-boss proxy listening on http://${proxy.hostname}:${info.port}`)
} catch (err) {
  logger.error(err as Error)
  process.exit(1)
}
