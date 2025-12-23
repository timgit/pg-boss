import assert from 'node:assert'
import { DEFAULT_SCHEMA } from './plans.ts'
import type * as types from './types.ts'

const POLICY = {
  MAX_EXPIRATION_HOURS: 24,
  MIN_POLLING_INTERVAL_MS: 500,
  MAX_RETENTION_DAYS: 365
}

function assertObjectName (value: string, name: string = 'Name') {
  assert(/^[\w.-]+$/.test(value), `${name} can only contain alphanumeric characters, underscores, hyphens, or periods`)
}

function validateQueueArgs (config: any = {}) {
  assert(!('deadLetter' in config) || config.deadLetter === null || (typeof config.deadLetter === 'string'), 'deadLetter must be a string')

  if (config.deadLetter) {
    assertObjectName(config.deadLetter, 'deadLetter')
  }

  validateRetryConfig(config)
  validateExpirationConfig(config)
  validateRetentionConfig(config)
  validateDeletionConfig(config)
}

function checkSendArgs (args: any): types.Request {
  let name, data, options

  if (typeof args[0] === 'string') {
    name = args[0]
    data = args[1]

    assert(typeof data !== 'function', 'send() cannot accept a function as the payload.  Did you intend to use work()?')

    options = args[2]
  } else if (typeof args[0] === 'object') {
    assert(args.length === 1, 'send object API only accepts 1 argument')

    const job = args[0]

    assert(job, 'boss requires all jobs to have a name')

    name = job.name
    data = job.data
    options = job.options
  }

  options = options || {}

  assert(name, 'boss requires all jobs to have a queue name')
  assert(typeof options === 'object', 'options should be an object')

  options = { ...options }

  assert(!('priority' in options) || (Number.isInteger(options.priority)), 'priority must be an integer')
  options.priority = options.priority || 0

  options.startAfter = (options.startAfter instanceof Date && typeof options.startAfter.toISOString === 'function')
    ? options.startAfter.toISOString()
    : (+options.startAfter > 0)
        ? '' + options.startAfter
        : (typeof options.startAfter === 'string')
            ? options.startAfter
            : undefined

  validateRetryConfig(options)
  validateExpirationConfig(options)
  validateRetentionConfig(options)
  validateDeletionConfig(options)
  validateGroupConfig(options)

  return { name, data, options }
}

function validateGroupConfig (config: any) {
  if (!('group' in config) || config.group === undefined || config.group === null) {
    return
  }
  assert(typeof config.group === 'object', 'group must be an object')
  assert(typeof config.group.id === 'string' && config.group.id.length > 0, 'group.id must be a non-empty string')
  assert(!('tier' in config.group) || (typeof config.group.tier === 'string' && config.group.tier.length > 0), 'group.tier must be a non-empty string if provided')
}

function validateGroupConcurrencyConfig (config: any) {
  if (!('groupConcurrency' in config) || config.groupConcurrency === undefined || config.groupConcurrency === null) {
    return
  }
  if (typeof config.groupConcurrency === 'number') {
    assert(Number.isInteger(config.groupConcurrency) && config.groupConcurrency >= 1, 'groupConcurrency must be an integer >= 1')
    return
  }
  assert(typeof config.groupConcurrency === 'object', 'groupConcurrency must be a number or an object with { default, tiers? }')
  assert(Number.isInteger(config.groupConcurrency.default) && config.groupConcurrency.default >= 1, 'groupConcurrency.default must be an integer >= 1')
  if ('tiers' in config.groupConcurrency && config.groupConcurrency.tiers) {
    assert(typeof config.groupConcurrency.tiers === 'object', 'groupConcurrency.tiers must be an object')
    for (const [tier, limit] of Object.entries(config.groupConcurrency.tiers)) {
      assert(typeof tier === 'string' && tier.length > 0, 'groupConcurrency tier keys must be non-empty strings')
      assert(Number.isInteger(limit) && (limit as number) >= 1, `groupConcurrency.tiers["${tier}"] must be an integer >= 1`)
    }
  }
}

function checkWorkArgs (name: string, args: any[]): {
  options: types.ResolvedWorkOptions
  callback: types.WorkHandler<any>
} {
  let options, callback

  assert(name, 'queue name is required')

  if (args.length === 1) {
    callback = args[0]
    options = {}
  } else if (args.length > 1) {
    options = args[0] || {}
    callback = args[1]
  }

  assert(typeof callback === 'function', 'expected callback to be a function')
  assert(typeof options === 'object', 'expected config to be an object')

  options = { ...options }

  applyPollingInterval(options)

  assert(!('batchSize' in options) || (Number.isInteger(options.batchSize) && options.batchSize >= 1), 'batchSize must be an integer > 0')
  assert(!('includeMetadata' in options) || typeof options.includeMetadata === 'boolean', 'includeMetadata must be a boolean')
  assert(!('priority' in options) || typeof options.priority === 'boolean', 'priority must be a boolean')
  assert(!('concurrency' in options) || (Number.isInteger(options.concurrency) && options.concurrency >= 1), 'concurrency must be an integer >= 1')
  validateGroupConcurrencyConfig(options)

  return { options, callback }
}

function checkFetchArgs (name: string, options: any) {
  assert(name, 'missing queue name')

  assert(!('batchSize' in options) || (Number.isInteger(options.batchSize) && options.batchSize >= 1), 'batchSize must be an integer > 0')
  assert(!('includeMetadata' in options) || typeof options.includeMetadata === 'boolean', 'includeMetadata must be a boolean')
  assert(!('priority' in options) || typeof options.priority === 'boolean', 'priority must be a boolean')
  assert(!('ignoreStartAfter' in options) || typeof options.ignoreStartAfter === 'boolean', 'ignoreStartAfter must be a boolean')
}

function getConfig (value: string | types.ConstructorOptions): types.ResolvedConstructorOptions {
  assert(value && (typeof value === 'object' || typeof value === 'string'),
    'configuration assert: string or config object is required to connect to postgres')

  const config = (typeof value === 'string')
    ? { connectionString: value }
    : { ...value }

  config.schedule = ('schedule' in config) ? config.schedule : true
  config.supervise = ('supervise' in config) ? config.supervise : true
  config.migrate = ('migrate' in config) ? config.migrate : true
  config.createSchema = ('createSchema' in config) ? config.createSchema : true

  applySchemaConfig(config)
  applyOpsConfig(config)
  applyScheduleConfig(config)
  validateWarningConfig(config)

  return config as types.ResolvedConstructorOptions
}

function applySchemaConfig (config: types.ConstructorOptions) {
  if (config.schema) {
    assertPostgresObjectName(config.schema)
  }

  config.schema = config.schema || DEFAULT_SCHEMA
}

function validateWarningConfig (config: any) {
  assert(!('warningQueueSize' in config) || config.warningQueueSize >= 1,
    'configuration assert: warningQueueSize must be at least 1')

  assert(!('warningSlowQuerySeconds' in config) || config.warningSlowQuerySeconds >= 1,
    'configuration assert: warningSlowQuerySeconds must be at least 1')
}

function assertPostgresObjectName (name: string) {
  assert(typeof name === 'string', 'Name must be a string')
  assert(name.length <= 50, 'Name cannot exceed 50 characters')
  assert(!/\W/.test(name), 'Name can only contain alphanumeric characters or underscores')
  assert(!/^\d/.test(name), 'Name cannot start with a number')
}

function assertQueueName (name: string) {
  assert(name, 'Name is required')
  assert(typeof name === 'string', 'Name must be a string')
  assertObjectName(name)
}

function assertKey (key: string) {
  if (!key) return
  assert(typeof key === 'string', 'Key must be a string')
  assertObjectName(key, 'Key')
}

function validateRetentionConfig (config: any) {
  assert(!('retentionSeconds' in config) || config.retentionSeconds >= 1,
    'configuration assert: retentionSeconds must be at least every second')
}

function validateExpirationConfig (config: any) {
  assert(!('expireInSeconds' in config) || config.expireInSeconds >= 1,
    'configuration assert: expireInSeconds must be at least every second')

  assert(!config.expireInSeconds || config.expireInSeconds / 60 / 60 < POLICY.MAX_EXPIRATION_HOURS, `configuration assert: expiration cannot exceed ${POLICY.MAX_EXPIRATION_HOURS} hours`)
}

function validateRetryConfig (config: any) {
  assert(!('retryDelay' in config) || (Number.isInteger(config.retryDelay) && config.retryDelay >= 0), 'retryDelay must be an integer >= 0')
  assert(!('retryLimit' in config) || (Number.isInteger(config.retryLimit) && config.retryLimit >= 0), 'retryLimit must be an integer >= 0')
  assert(!('retryBackoff' in config) || (config.retryBackoff === true || config.retryBackoff === false), 'retryBackoff must be either true or false')
  assert(!('retryDelayMax' in config) || config.retryDelayMax === null || config.retryBackoff === true, 'retryDelayMax can only be set if retryBackoff is true')
  assert(!('retryDelayMax' in config) || config.retryDelayMax === null || (Number.isInteger(config.retryDelayMax) && config.retryDelayMax >= 0), 'retryDelayMax must be an integer >= 0')
}

function applyPollingInterval (config: any) {
  assert(!('pollingIntervalSeconds' in config) || config.pollingIntervalSeconds >= POLICY.MIN_POLLING_INTERVAL_MS / 1000,
    `configuration assert: pollingIntervalSeconds must be at least every ${POLICY.MIN_POLLING_INTERVAL_MS}ms`)

  config.pollingInterval = ('pollingIntervalSeconds' in config)
    ? config.pollingIntervalSeconds * 1000
    : 2000
}

function applyOpsConfig (config: any) {
  assert(!('superviseIntervalSeconds' in config) || config.superviseIntervalSeconds >= 1,
    'configuration assert: superviseIntervalSeconds must be at least every second')

  config.superviseIntervalSeconds = config.superviseIntervalSeconds || 60

  assert(config.superviseIntervalSeconds / 60 / 60 <= POLICY.MAX_EXPIRATION_HOURS,
    `configuration assert: superviseIntervalSeconds cannot exceed ${POLICY.MAX_EXPIRATION_HOURS} hours`)

  assert(!('maintenanceIntervalSeconds' in config) || config.maintenanceIntervalSeconds >= 1,
    'configuration assert: maintenanceIntervalSeconds must be at least every second')

  config.maintenanceIntervalSeconds = config.maintenanceIntervalSeconds || POLICY.MAX_EXPIRATION_HOURS * 60 * 60

  assert(config.maintenanceIntervalSeconds / 60 / 60 <= POLICY.MAX_EXPIRATION_HOURS,
    `configuration assert: maintenanceIntervalSeconds cannot exceed ${POLICY.MAX_EXPIRATION_HOURS} hours`)

  assert(!('monitorIntervalSeconds' in config) || config.monitorIntervalSeconds >= 1,
    'configuration assert: monitorIntervalSeconds must be at least every second')

  config.monitorIntervalSeconds = config.monitorIntervalSeconds || 60

  assert(config.monitorIntervalSeconds / 60 / 60 <= POLICY.MAX_EXPIRATION_HOURS,
    `configuration assert: monitorIntervalSeconds cannot exceed ${POLICY.MAX_EXPIRATION_HOURS} hours`)

  assert(!('queueCacheIntervalSeconds' in config) || config.queueCacheIntervalSeconds >= 1,
    'configuration assert: queueCacheIntervalSeconds must be at least every second')

  config.queueCacheIntervalSeconds = config.queueCacheIntervalSeconds || 60

  assert(config.queueCacheIntervalSeconds / 60 / 60 <= POLICY.MAX_EXPIRATION_HOURS,
    `configuration assert: queueCacheIntervalSeconds cannot exceed ${POLICY.MAX_EXPIRATION_HOURS} hours`)
}

function validateDeletionConfig (config: any) {
  assert(!('deleteAfterSeconds' in config) || config.deleteAfterSeconds >= 1,
    'configuration assert: deleteAfterSeconds must be at least every second')
}

function applyScheduleConfig (config: any) {
  assert(!('clockMonitorIntervalSeconds' in config) || (config.clockMonitorIntervalSeconds >= 1 && config.clockMonitorIntervalSeconds <= 600),
    'configuration assert: clockMonitorIntervalSeconds must be between 1 second and 10 minutes')

  config.clockMonitorIntervalSeconds = config.clockMonitorIntervalSeconds || 600

  assert(!('cronMonitorIntervalSeconds' in config) || (config.cronMonitorIntervalSeconds >= 1 && config.cronMonitorIntervalSeconds <= 45),
    'configuration assert: cronMonitorIntervalSeconds must be between 1 and 45 seconds')

  config.cronMonitorIntervalSeconds = config.cronMonitorIntervalSeconds || 30

  assert(!('cronWorkerIntervalSeconds' in config) || (config.cronWorkerIntervalSeconds >= 1 && config.cronWorkerIntervalSeconds <= 45),
    'configuration assert: cronWorkerIntervalSeconds must be between 1 and 45 seconds')

  config.cronWorkerIntervalSeconds = config.cronWorkerIntervalSeconds || 5
}

export {
  assertKey,
  assertPostgresObjectName,
  assertQueueName,
  checkFetchArgs,
  checkSendArgs,
  checkWorkArgs,
  getConfig,
  POLICY,
  validateQueueArgs
}
