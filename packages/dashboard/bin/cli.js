#!/usr/bin/env node
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import process from 'process'

// Set PORT and HOST before importing the server
if (!process.env.PORT) process.env.PORT = '3000'
if (!process.env.HOST) process.env.HOST = '0.0.0.0'

// Change to package directory so relative paths in the build resolve correctly
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(packageRoot)

// Import the built server - it will auto-start in production mode
await import('../build/server/index.js')
