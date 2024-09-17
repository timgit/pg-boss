const assert = require('node:assert')
const { DEFAULT_SCHEMA } = require('./plans')

const POLICY = {
  MAX_EXPIRATION_HOURS: 24,
  MIN_POLLING_INTERVAL_MS: 500,
  MAX_RETENTION_DAYS: 365
}

module.exports = {
  POLICY,
  getConfig,
  checkSendArgs,
  validateQueueArgs,
  checkWorkArgs,
  checkFetchArgs,
  warnClockSkew,
  assertPostgresObjectName,
  assertQueueName
}

const WARNINGS = {
  CLOCK_SKEW: {
    message: 'Timekeeper detected clock skew between this instance and the database server. This will not affect scheduling operations, but this warning is shown any time the skew exceeds 60 seconds.',
    code: 'pg-boss-w01'
  }
}

function validateQueueArgs (config = {}) {
  assert(!('deadLetter' in config) || config.deadLetter === null || (typeof config.deadLetter === 'string'), 'deadLetter must be a string')
  assert(!('deadLetter' in config) || config.deadLetter === null || /[\w-]/.test(config.deadLetter), 'deadLetter can only contain alphanumeric characters, underscores, or hyphens')

  validateRetryConfig(config)
  validateExpirationConfig(config)
  validateRetentionConfig(config)
  validateDeletionConfig(config)
}

function checkSendArgs (args) {
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
    : (options.startAfter > 0)
        ? '' + options.startAfter
        : (typeof options.startAfter === 'string')
            ? options.startAfter
            : null

  if (options.onComplete) {
    emitWarning(WARNINGS.ON_COMPLETE_REMOVED)
  }

  return { name, data, options }
}

function checkWorkArgs (name, args) {
  let options, callback

  assert(name, 'missing job name')

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

  options.batchSize = options.batchSize || 1

  return { options, callback }
}

function checkFetchArgs (name, options) {
  assert(name, 'missing queue name')

  assert(!('batchSize' in options) || (Number.isInteger(options.batchSize) && options.batchSize >= 1), 'batchSize must be an integer > 0')
  assert(!('includeMetadata' in options) || typeof options.includeMetadata === 'boolean', 'includeMetadata must be a boolean')
  assert(!('priority' in options) || typeof options.priority === 'boolean', 'priority must be a boolean')

  options.batchSize = options.batchSize || 1
}

function getConfig (value) {
  assert(value && (typeof value === 'object' || typeof value === 'string'),
    'configuration assert: string or config object is required to connect to postgres')

  const config = (typeof value === 'string')
    ? { connectionString: value }
    : { ...value }

  config.schedule = ('schedule' in config) ? config.schedule : true
  config.supervise = ('supervise' in config) ? config.supervise : true
  config.migrate = ('migrate' in config) ? config.migrate : true

  applySchemaConfig(config)
  applyMaintenanceConfig(config)
  applyMonitoringConfig(config)

  return config
}

function applySchemaConfig (config) {
  if (config.schema) {
    assertPostgresObjectName(config.schema)
  }

  config.schema = config.schema || DEFAULT_SCHEMA
}

function assertPostgresObjectName (name) {
  assert(typeof name === 'string', 'Name must be a string')
  assert(name.length <= 50, 'Name cannot exceed 50 characters')
  assert(!/\W/.test(name), 'Name can only contain alphanumeric characters or underscores')
  assert(!/^\d/.test(name), 'Name cannot start with a number')
}

function assertQueueName (name) {
  assert(name, 'Name is required')
  assert(typeof name === 'string', 'Name must be a string')
  assert(/[\w-]/.test(name), 'Name can only contain alphanumeric characters, underscores, or hyphens')
}

function validateRetentionConfig (config) {
  assert(!('retentionSeconds' in config) || config.retentionSeconds >= 1,
    'configuration assert: retentionSeconds must be at least every second')
}

function validateExpirationConfig (config) {
  assert(!('expireInSeconds' in config) || config.expireInSeconds >= 1,
    'configuration assert: expireInSeconds must be at least every second')

  assert(!config.expireInSeconds || config.expireInSeconds / 60 / 60 < POLICY.MAX_EXPIRATION_HOURS, `configuration assert: expiration cannot exceed ${POLICY.MAX_EXPIRATION_HOURS} hours`)
}

function validateRetryConfig (config) {
  assert(!('retryDelay' in config) || (Number.isInteger(config.retryDelay) && config.retryDelay >= 0), 'retryDelay must be an integer >= 0')
  assert(!('retryLimit' in config) || (Number.isInteger(config.retryLimit) && config.retryLimit >= 0), 'retryLimit must be an integer >= 0')
  assert(!('retryBackoff' in config) || (config.retryBackoff === true || config.retryBackoff === false), 'retryBackoff must be either true or false')
}

function applyPollingInterval (config) {
  assert(!('pollingIntervalSeconds' in config) || config.pollingIntervalSeconds >= POLICY.MIN_POLLING_INTERVAL_MS / 1000,
    `configuration assert: pollingIntervalSeconds must be at least every ${POLICY.MIN_POLLING_INTERVAL_MS}ms`)

  config.pollingInterval = ('pollingIntervalSeconds' in config)
    ? config.pollingIntervalSeconds * 1000
    : 2000
}

function applyMaintenanceConfig (config) {
  assert(!('maintenanceIntervalSeconds' in config) || config.maintenanceIntervalSeconds >= 1,
    'configuration assert: maintenanceIntervalSeconds must be at least every second')

  config.maintenanceIntervalSeconds = config.maintenanceIntervalSeconds || POLICY.MAX_EXPIRATION_HOURS * 60 * 60

  assert(config.maintenanceIntervalSeconds / 60 / 60 <= POLICY.MAX_EXPIRATION_HOURS,
    `configuration assert: maintenance interval cannot exceed ${POLICY.MAX_EXPIRATION_HOURS} hours`)

  assert(!('monitorIntervalSeconds' in config) || config.monitorIntervalSeconds >= 1,
    'configuration assert: monitorIntervalSeconds must be at least every second')

  config.monitorIntervalSeconds = config.monitorIntervalSeconds || 60
}

function validateDeletionConfig (config) {
  assert(!('deleteAfterSeconds' in config) || config.deleteAfterSeconds >= 1,
    'configuration assert: deleteAfterSeconds must be at least every second')
}

function applyMonitoringConfig (config) {
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

function warnClockSkew (message) {
  emitWarning(WARNINGS.CLOCK_SKEW, message, { force: true })
}

function emitWarning (warning, message, options = {}) {
  const { force } = options

  if (force || !warning.warned) {
    warning.warned = true
    message = `${warning.message} ${message || ''}`
    process.emitWarning(message, warning.type, warning.code)
  }
}
