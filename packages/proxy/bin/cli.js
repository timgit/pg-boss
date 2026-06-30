#!/usr/bin/env node
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import process from 'process'

// Set PORT and HOST before importing the server. Default HOST to 0.0.0.0 (the
// service default is localhost) so the proxy is reachable when run in a container.
if (!process.env.PORT) process.env.PORT = '3000'
if (!process.env.HOST) process.env.HOST = '0.0.0.0'

// Change to package directory so relative paths resolve correctly
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(packageRoot)

// Import the built HTTP server - it starts listening on import
await import('../dist/server.js')
