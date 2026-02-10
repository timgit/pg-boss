#!/usr/bin/env node
import { serve } from '@hono/node-server'

const port = process.env.PORT || 3000
const host = process.env.HOST || '0.0.0.0'

// Import the built server
const { default: server } = await import('../build/server/index.js')

// Start the server
serve(
  {
    fetch: server.fetch,
    port: parseInt(String(port), 10),
    hostname: host,
  },
  (info) => {
    console.log(`pg-boss dashboard server running at http://${info.address}:${info.port}`)
    console.log('Open your browser to view the dashboard')
  }
)
