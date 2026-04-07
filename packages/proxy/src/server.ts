import { createProxyServerNode } from './node.js'
import { getLogger } from '@logtape/logtape'

const proxy = await createProxyServerNode()
const logger = getLogger(['proxy'])

try {
  const info = await proxy.start()
  logger.info(`listening on http://${proxy.hostname}:${info.port}`)
} catch (err) {
  logger.error(err as Error)
  process.exit(1)
}
