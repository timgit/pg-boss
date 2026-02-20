import { createProxyServerNode } from './node.js'
import { configureLogging } from './env.js'
import { getLogger } from '@logtape/logtape'

const logFormat = process.env.PGBOSS_PROXY_LOG_FORMAT as 'text' | 'json' | undefined
await configureLogging(logFormat)

const logger = getLogger(['pg-boss', 'proxy'])
const proxy = createProxyServerNode()

try {
  const info = await proxy.start()
  logger.info(`listening on http://${proxy.hostname}:${info.port}`)
} catch (err) {
  logger.error(err as Error)
  process.exit(1)
}
