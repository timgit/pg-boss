import type { ConstructorOptions } from 'pg-boss'
import { createProxyApp, createProxyService, type ProxyApp, type ProxyOptions, type ProxyService } from './index.js'

type ProxyNodeOptions = Omit<ProxyOptions, 'options'> & {
  connectionString?: string
  options?: ConstructorOptions
}

const resolveOptions = (options: ProxyNodeOptions): ConstructorOptions => {
  if (options.connectionString && options.options) {
    throw new Error('Provide either connectionString or options, not both.')
  }

  if (options.connectionString) {
    return { connectionString: options.connectionString }
  }

  if (options.options) {
    return options.options
  }

  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL }
  }

  throw new Error('Proxy requires PgBoss constructor options or DATABASE_URL.')
}

export const createProxyAppNode = (options: ProxyNodeOptions = {}): ProxyApp => {
  const { connectionString: _, options: __, ...rest } = options
  return createProxyApp({ ...rest, options: resolveOptions(options) })
}

export const createProxyServiceNode = (options: ProxyNodeOptions = {}): ProxyService => {
  const { connectionString: _, options: __, ...rest } = options
  return createProxyService({ ...rest, options: resolveOptions(options) })
}

export type { ProxyNodeOptions }
