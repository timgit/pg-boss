import type { ConstructorOptions } from 'pg-boss'
import { createProxyApp, createProxyService, type ProxyApp, type ProxyService } from './index.js'

type ProxyNodeOptions = {
  connectionString?: string
  options?: ConstructorOptions
  prefix?: string
}

const resolveOptions = (options: ProxyNodeOptions): ConstructorOptions => {
  let args = {} as ConstructorOptions

  if (options.connectionString) {
    args.connectionString = options.connectionString
  } else if (options.options) {
    args = options.options
  } else if (process.env.DATABASE_URL) {
    args.connectionString = process.env.DATABASE_URL
  }

  if (Object.keys(args).length === 0) {
    throw new Error('Proxy requires PgBoss constructor options or DATABASE_URL.')
  }

  return args
}

export const createProxyAppNode = (options: ProxyNodeOptions = {}): ProxyApp => {
  const resolvedOptions = resolveOptions(options)
  return createProxyApp({ options: resolvedOptions, prefix: options.prefix })
}

export const createProxyServiceNode = (options: ProxyNodeOptions = {}): ProxyService => {
  const resolvedOptions = resolveOptions(options)
  return createProxyService({ options: resolvedOptions, prefix: options.prefix })
}

export type { ProxyNodeOptions }
