import { createProxyServerNode } from './node.js'

const proxy = createProxyServerNode()

try {
  const info = await proxy.start()
  console.log(`pg-boss proxy listening on http://${proxy.hostname}:${info.port}`)
} catch (err) {
  console.error('Failed to start pg-boss:', err instanceof Error ? err.message : err)
  process.exit(1)
}
