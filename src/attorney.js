const assert = require('assert')
const { DEFAULT_SCHEMA, SINGLETON_QUEUE_KEY } = require('./plans')

module.exports = {
  getConfig,
  checkSendArgs,
  checkInsertArgs,
  checkWorkArgs,
  checkFetchArgs,
  warnClockSkew
}

const WARNINGS = {
  EXPIRE_IN_REMOVED: {
    message: '\'expireIn\' option detected. This option has been removed. Use expireInSeconds, expireInMinutes or expireInHours.',
    code: 'pg-boss-w01'
  },
  CLOCK_SKEW: {
    message: 'Timekeeper detected clock skew between this instance and the database server. This will not affect scheduling operations, but this warning is shown any time the skew exceeds 60 seconds.',
    code: 'pg-boss-w02'
  },
  CRON_DISABLED: {
    message: 'Archive interval is set less than 60s.  Cron processing is disabled.',
    code: 'pg-boss-w03'
  }
}

function checkSendArgs (args, defaults) {
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

  applyRetryConfig(options, defaults)
  applyExpirationConfig(options, defaults)
  applyRetentionConfig(options, defaults)
  applyCompletionConfig(options, defaults)
  applySingletonKeyConfig(options)

  const { startAfter, singletonSeconds, singletonMinutes, singletonHours } = options

  options.startAfter = (startAfter instanceof Date && typeof startAfter.toISOString === 'function')
    ? startAfter.toISOString()
    : (startAfter > 0)
        ? '' + startAfter
        : (typeof startAfter === 'string')
            ? startAfter
            : null

  options.singletonSeconds = (singletonHours > 0)
    ? singletonHours * 60 * 60
    : (singletonMinutes > 0)
        ? singletonMinutes * 60
        : (singletonSeconds > 0)
            ? singletonSeconds
            : null

  assert(!singletonSeconds || singletonSeconds <= defaults.archiveSeconds, `throttling interval ${singletonSeconds}s cannot exceed archive interval ${defaults.archiveSeconds}s`)

  return { name, data, options }
}

function checkInsertArgs (jobs) {
  assert(Array.isArray(jobs), `jobs argument should be an array.  Received '${typeof jobs}'`)
  return jobs.map(job => {
    job = { ...job }
    applySingletonKeyConfig(job)
    return job
  })
}

function applySingletonKeyConfig (options) {
  if (options.singletonKey && options.useSingletonQueue && options.singletonKey !== SINGLETON_QUEUE_KEY) {
    options.singletonKey = SINGLETON_QUEUE_KEY + options.singletonKey
  }
  delete options.useSingletonQueue
}

function checkWorkArgs (name, args, defaults) {
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

  applyNewJobCheckInterval(options, defaults)

  assert(!('teamConcurrency' in options) ||
    (Number.isInteger(options.teamConcurrency) && options.teamConcurrency >= 1 && options.teamConcurrency <= 1000),
  'teamConcurrency must be an integer between 1 and 1000')

  assert(!('teamSize' in options) || (Number.isInteger(options.teamSize) && options.teamSize >= 1), 'teamSize must be an integer > 0')
  assert(!('batchSize' in options) || (Number.isInteger(options.batchSize) && options.batchSize >= 1), 'batchSize must be an integer > 0')
  assert(!('includeMetadata' in options) || typeof options.includeMetadata === 'boolean', 'includeMetadata must be a boolean')

  return { options, callback }
}

function checkFetchArgs (name, batchSize, options) {
  assert(name, 'missing queue name')

  name = sanitizeQueueNameForFetch(name)

  assert(!batchSize || (Number.isInteger(batchSize) && batchSize >= 1), 'batchSize must be an integer > 0')
  assert(!('includeMetadata' in options) || typeof options.includeMetadata === 'boolean', 'includeMetadata must be a boolean')

  return { name }
}

function sanitizeQueueNameForFetch (name) {
  return name.replace(/[%_*]/g, match => match === '*' ? '%' : '\\' + match)
}

function getConfig (value) {
  assert(value && (typeof value === 'object' || typeof value === 'string'),
    'configuration assert: string or config object is required to connect to postgres')

  const config = (typeof value === 'string')
    ? { connectionString: value }
    : { ...value }

  applyDatabaseConfig(config)
  applyMaintenanceConfig(config)
  applyArchiveConfig(config)
  applyArchiveFailedConfig(config)
  applyDeleteConfig(config)
  applyMonitoringConfig(config)
  applyUuidConfig(config)

  applyNewJobCheckInterval(config)
  applyExpirationConfig(config)
  applyRetentionConfig(config)
  applyCompletionConfig(config)

  return config
}

function applyDatabaseConfig (config) {
  if (config.schema) {
    assert(typeof config.schema === 'string', 'configuration assert: schema must be a string')
    assert(config.schema.length <= 50, 'configuration assert: schema name cannot exceed 50 characters')
    assert(!/\W/.test(config.schema), `configuration assert: ${config.schema} cannot be used as a schema. Only alphanumeric characters and underscores are allowed`)
  }

  config.schema = config.schema || DEFAULT_SCHEMA
}

function applyArchiveConfig (config) {
  const ARCHIVE_DEFAULT = 60 * 60 * 12

  assert(!('archiveCompletedAfterSeconds' in config) || config.archiveCompletedAfterSeconds >= 1,
    'configuration assert: archiveCompletedAfterSeconds must be at least every second and less than ')

  config.archiveSeconds = config.archiveCompletedAfterSeconds || ARCHIVE_DEFAULT
  config.archiveInterval = `${config.archiveSeconds} seconds`

  if (config.archiveSeconds < 60) {
    emitWarning(WARNINGS.CRON_DISABLED)
  }
}

function applyArchiveFailedConfig (config) {
  assert(!('archiveFailedAfterSeconds' in config) || config.archiveFailedAfterSeconds >= 1,
    'configuration assert: archiveFailedAfterSeconds must be at least every second and less than ')

  config.archiveFailedSeconds = config.archiveFailedAfterSeconds || config.archiveSeconds
  config.archiveFailedInterval = `${config.archiveFailedSeconds} seconds`

  // Do not emit warning twice
  if (config.archiveFailedSeconds < 60 && config.archiveSeconds >= 60) {
    emitWarning(WARNINGS.CRON_DISABLED)
  }
}

function applyCompletionConfig (config, defaults) {
  assert(!('onComplete' in config) || config.onComplete === true || config.onComplete === false,
    'configuration assert: onComplete must be either true or false')

  if (!('onComplete' in config)) {
    config.onComplete = defaults
      ? defaults.onComplete
      : false
  }
}

function applyRetentionConfig (config, defaults) {
  assert(!('retentionSeconds' in config) || config.retentionSeconds >= 1,
    'configuration assert: retentionSeconds must be at least every second')

  assert(!('retentionMinutes' in config) || config.retentionMinutes >= 1,
    'configuration assert: retentionMinutes must be at least every minute')

  assert(!('retentionHours' in config) || config.retentionHours >= 1,
    'configuration assert: retentionHours must be at least every hour')

  assert(!('retentionDays' in config) || config.retentionDays >= 1,
    'configuration assert: retentionDays must be at least every day')

  const keepUntil = ('retentionDays' in config)
    ? `${config.retentionDays} days`
    : ('retentionHours' in config)
        ? `${config.retentionHours} hours`
        : ('retentionMinutes' in config)
            ? `${config.retentionMinutes} minutes`
            : ('retentionSeconds' in config)
                ? `${config.retentionSeconds} seconds`
                : defaults
                  ? defaults.keepUntil
                  : '14 days'

  config.keepUntil = keepUntil
}

function applyExpirationConfig (config, defaults) {
  if ('expireIn' in config) {
    emitWarning(WARNINGS.EXPIRE_IN_REMOVED)
  }

  assert(!('expireInSeconds' in config) || config.expireInSeconds >= 1,
    'configuration assert: expireInSeconds must be at least every second')

  assert(!('expireInMinutes' in config) || config.expireInMinutes >= 1,
    'configuration assert: expireInMinutes must be at least every minute')

  assert(!('expireInHours' in config) || config.expireInHours >= 1,
    'configuration assert: expireInHours must be at least every hour')

  const expireIn = ('expireInHours' in config)
    ? `${config.expireInHours} hours`
    : ('expireInMinutes' in config)
        ? `${config.expireInMinutes} minutes`
        : ('expireInSeconds' in config)
            ? `${config.expireInSeconds} seconds`
            : defaults
              ? defaults.expireIn
              : '15 minutes'

  config.expireIn = expireIn
}

function applyRetryConfig (config, defaults) {
  assert(!('retryDelay' in config) || (Number.isInteger(config.retryDelay) && config.retryDelay >= 0), 'retryDelay must be an integer >= 0')
  assert(!('retryLimit' in config) || (Number.isInteger(config.retryLimit) && config.retryLimit >= 0), 'retryLimit must be an integer >= 0')
  assert(!('retryBackoff' in config) || (config.retryBackoff === true || config.retryBackoff === false), 'retryBackoff must be either true or false')

  if (defaults) {
    config.retryDelay = config.retryDelay || defaults.retryDelay
    config.retryLimit = config.retryLimit || defaults.retryLimit
    config.retryBackoff = config.retryBackoff || defaults.retryBackoff
  }

  config.retryDelay = config.retryDelay || 0
  config.retryLimit = config.retryLimit || 0
  config.retryBackoff = !!config.retryBackoff
  config.retryDelay = (config.retryBackoff && !config.retryDelay) ? 1 : config.retryDelay
  config.retryLimit = (config.retryDelay && !config.retryLimit) ? 1 : config.retryLimit
}

function applyNewJobCheckInterval (config, defaults) {
  const second = 1000

  assert(!('newJobCheckInterval' in config) || config.newJobCheckInterval >= 100,
    'configuration assert: newJobCheckInterval must be at least every 100ms')

  assert(!('newJobCheckIntervalSeconds' in config) || config.newJobCheckIntervalSeconds >= 1,
    'configuration assert: newJobCheckIntervalSeconds must be at least every second')

  config.newJobCheckInterval = ('newJobCheckIntervalSeconds' in config)
    ? config.newJobCheckIntervalSeconds * second
    : ('newJobCheckInterval' in config)
        ? config.newJobCheckInterval
        : defaults
          ? defaults.newJobCheckInterval
          : second * 2
}

function applyMaintenanceConfig (config) {
  assert(!('maintenanceIntervalSeconds' in config) || config.maintenanceIntervalSeconds >= 1,
    'configuration assert: maintenanceIntervalSeconds must be at least every second')

  assert(!('maintenanceIntervalMinutes' in config) || config.maintenanceIntervalMinutes >= 1,
    'configuration assert: maintenanceIntervalMinutes must be at least every minute')

  config.maintenanceIntervalSeconds = ('maintenanceIntervalMinutes' in config)
    ? config.maintenanceIntervalMinutes * 60
    : ('maintenanceIntervalSeconds' in config)
        ? config.maintenanceIntervalSeconds
        : 120
}

function applyDeleteConfig (config) {
  assert(!('deleteAfterSeconds' in config) || config.deleteAfterSeconds >= 1,
    'configuration assert: deleteAfterSeconds must be at least every second')

  assert(!('deleteAfterMinutes' in config) || config.deleteAfterMinutes >= 1,
    'configuration assert: deleteAfterMinutes must be at least every minute')

  assert(!('deleteAfterHours' in config) || config.deleteAfterHours >= 1,
    'configuration assert: deleteAfterHours must be at least every hour')

  assert(!('deleteAfterDays' in config) || config.deleteAfterDays >= 1,
    'configuration assert: deleteAfterDays must be at least every day')

  const deleteAfter = ('deleteAfterDays' in config)
    ? `${config.deleteAfterDays} days`
    : ('deleteAfterHours' in config)
        ? `${config.deleteAfterHours} hours`
        : ('deleteAfterMinutes' in config)
            ? `${config.deleteAfterMinutes} minutes`
            : ('deleteAfterSeconds' in config)
                ? `${config.deleteAfterSeconds} seconds`
                : '7 days'

  config.deleteAfter = deleteAfter
}

function applyMonitoringConfig (config) {
  assert(!('monitorStateIntervalSeconds' in config) || config.monitorStateIntervalSeconds >= 1,
    'configuration assert: monitorStateIntervalSeconds must be at least every second')

  assert(!('monitorStateIntervalMinutes' in config) || config.monitorStateIntervalMinutes >= 1,
    'configuration assert: monitorStateIntervalMinutes must be at least every minute')

  config.monitorStateIntervalSeconds =
    ('monitorStateIntervalMinutes' in config)
      ? config.monitorStateIntervalMinutes * 60
      : ('monitorStateIntervalSeconds' in config)
          ? config.monitorStateIntervalSeconds
          : null

  const TEN_MINUTES_IN_SECONDS = 600

  assert(!('clockMonitorIntervalSeconds' in config) || (config.clockMonitorIntervalSeconds >= 1 && config.clockMonitorIntervalSeconds <= TEN_MINUTES_IN_SECONDS),
    'configuration assert: clockMonitorIntervalSeconds must be between 1 second and 10 minutes')

  assert(!('clockMonitorIntervalMinutes' in config) || (config.clockMonitorIntervalMinutes >= 1 && config.clockMonitorIntervalMinutes <= 10),
    'configuration assert: clockMonitorIntervalMinutes must be between 1 and 10')

  config.clockMonitorIntervalSeconds =
    ('clockMonitorIntervalMinutes' in config)
      ? config.clockMonitorIntervalMinutes * 60
      : ('clockMonitorIntervalSeconds' in config)
          ? config.clockMonitorIntervalSeconds
          : TEN_MINUTES_IN_SECONDS

  assert(!('cronMonitorIntervalSeconds' in config) || (config.cronMonitorIntervalSeconds >= 1 && config.cronMonitorIntervalSeconds <= 60),
    'configuration assert: cronMonitorIntervalSeconds must be between 1 and 60 seconds')

  config.cronMonitorIntervalSeconds =
    ('cronMonitorIntervalSeconds' in config)
      ? config.cronMonitorIntervalSeconds
      : 60

  assert(!('cronWorkerIntervalSeconds' in config) || (config.cronWorkerIntervalSeconds >= 1 && config.cronWorkerIntervalSeconds <= 60),
    'configuration assert: cronWorkerIntervalSeconds must be between 1 and 60 seconds')

  config.cronWorkerIntervalSeconds =
    ('cronWorkerIntervalSeconds' in config)
      ? config.cronWorkerIntervalSeconds
      : 4
}

function applyUuidConfig (config) {
  assert(!('uuid' in config) || config.uuid === 'v1' || config.uuid === 'v4', 'configuration assert: uuid option only supports v1 or v4')
  config.uuid = config.uuid || 'v4'
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
