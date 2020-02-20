const assert = require('assert')

module.exports = {
  getConfig,
  checkPublishArgs,
  checkSubscribeArgs,
  checkFetchArgs
}

function checkPublishArgs (args) {
  let name, data, options

  if (typeof args[0] === 'string') {
    name = args[0]
    data = args[1]

    assert(typeof data !== 'function', 'publish() cannot accept a function as the payload.  Did you intend to use subscribe()?')

    options = args[2]
  } else if (typeof args[0] === 'object') {
    assert(args.length === 1, 'publish object API only accepts 1 argument')

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

  assert(!('retryDelay' in options) || (Number.isInteger(options.retryDelay) && options.retryDelay >= 0), 'retryDelay must be an integer >= 0')
  assert(!('retryLimit' in options) || (Number.isInteger(options.retryLimit) && options.retryLimit >= 0), 'retryLimit must be an integer >= 0')
  assert(!('retryBackoff' in options) || (options.retryBackoff === true || options.retryBackoff === false), 'retryBackoff must be either true or false')
  assert(!('priority' in options) || (Number.isInteger(options.priority)), 'priority must be an integer')

  const {
    startAfter,
    singletonSeconds,
    singletonMinutes,
    singletonHours,
    retryDelay = 0,
    retryLimit = 0,
    retryBackoff,
    priority = 0
  } = options

  options.startAfter = (startAfter instanceof Date && typeof startAfter.toISOString === 'function') ? startAfter.toISOString()
    : (startAfter > 0) ? '' + startAfter
      : (typeof startAfter === 'string') ? startAfter
        : null

  options.singletonSeconds = (singletonSeconds > 0) ? singletonSeconds
    : (singletonMinutes > 0) ? singletonMinutes * 60
      : (singletonHours > 0) ? singletonHours * 60 * 60
        : null

  options.retryDelay = retryDelay
  options.retryLimit = retryLimit
  options.priority = priority
  options.retryBackoff = !!retryBackoff
  options.retryDelay = (options.retryBackoff && !retryDelay) ? 1 : retryDelay
  options.retryLimit = (options.retryDelay && !retryLimit) ? 1 : retryLimit

  applyPublishRetentionConfig(options)
  applyPublishExpirationConfig(options)

  return { name, data, options }
}

function checkSubscribeArgs (name, args) {
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

  if (options) {
    assert(typeof options === 'object', 'expected config to be an object')
    options = { ...options }
  } else {
    options = {}
  }

  if ('newJobCheckInterval' in options || 'newJobCheckIntervalSeconds' in options) {
    applyNewJobCheckInterval(options)
  }

  assert(!('teamConcurrency' in options) ||
    (Number.isInteger(options.teamConcurrency) && options.teamConcurrency >= 1 && options.teamConcurrency <= 1000),
  'teamConcurrency must be an integer between 1 and 1000')

  assert(!('teamSize' in options) || (Number.isInteger(options.teamSize) && options.teamSize >= 1), 'teamSize must be an integer > 0')
  assert(!('batchSize' in options) || (Number.isInteger(options.batchSize) && options.batchSize >= 1), 'batchSize must be an integer > 0')

  name = sanitizeQueueNameForFetch(name)

  return { options, callback }
}

function checkFetchArgs (name, batchSize) {
  assert(name, 'missing queue name')

  name = sanitizeQueueNameForFetch(name)

  assert(!batchSize || batchSize >= 1, 'fetch() assert: optional batchSize arg must be at least 1')

  return { name, batchSize }
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
  applyNewJobCheckInterval(config)
  applyMaintenanceConfig(config)
  applyArchiveConfig(config)
  applyDeleteConfig(config)
  applyMonitoringConfig(config)
  applyUuidConfig(config)

  return config
}

function applyDatabaseConfig (config) {
  if (config.schema) {
    assert(typeof config.schema === 'string', 'configuration assert: schema must be a string')
    assert(config.schema.length <= 50, 'configuration assert: schema name cannot exceed 50 characters')
    assert(!/\W/.test(config.schema), `configuration assert: ${config.schema} cannot be used as a schema. Only alphanumeric characters and underscores are allowed`)
  }

  config.schema = config.schema || 'pgboss'

  // byodb means we don't apply connection pooling
  if (typeof config.db !== 'object') {
    assert(!('poolSize' in config) || config.poolSize >= 1,
      'configuration assert: poolSize must be at least 1')

    config.poolSize = config.poolSize || config.max || 10
  }
}

function applyPublishRetentionConfig (config) {
  assert(!('retentionSeconds' in config) || config.retentionSeconds >= 1,
    'configuration assert: retentionSeconds must be at least every second')

  assert(!('retentionMinutes' in config) || config.retentionMinutes >= 1,
    'configuration assert: retentionMinutes must be at least every minute')

  assert(!('retentionHours' in config) || config.retentionHours >= 1,
    'configuration assert: retentionHours must be at least every hour')

  assert(!('retentionDays' in config) || config.retentionDays >= 1,
    'configuration assert: retentionDays must be at least every day')

  const keepUntil =
    ('retentionDays' in config) ? `${config.retentionDays} days`
      : ('retentionHours' in config) ? `${config.retentionHours} hours`
        : ('retentionMinutes' in config) ? `${config.retentionMinutes} minutes`
          : ('retentionSeconds' in config) ? `${config.retentionSeconds} seconds`
            : '30 days'

  config.keepUntil = keepUntil
}

function applyPublishExpirationConfig (config) {
  assert(!('expireInSeconds' in config) || config.expireInSeconds >= 1,
    'configuration assert: expireInSeconds must be at least every second')

  assert(!('expireInMinutes' in config) || config.expireInMinutes >= 1,
    'configuration assert: expireInMinutes must be at least every minute')

  assert(!('expireInHours' in config) || config.expireInHours >= 1,
    'configuration assert: expireInHours must be at least every hour')

  const expireIn =
    ('expireInHours' in config) ? `${config.expireInHours} hours`
      : ('expireInMinutes' in config) ? `${config.expireInMinutes} minutes`
        : ('expireInSeconds' in config) ? `${config.expireInSeconds} seconds`
          : '15 minutes'

  config.expireIn = expireIn
}

function applyNewJobCheckInterval (config) {
  const second = 1000

  assert(!('newJobCheckInterval' in config) || config.newJobCheckInterval >= 100,
    'configuration assert: newJobCheckInterval must be at least every 100ms')

  assert(!('newJobCheckIntervalSeconds' in config) || config.newJobCheckIntervalSeconds >= 1,
    'configuration assert: newJobCheckIntervalSeconds must be at least every second')

  config.newJobCheckInterval =
    ('newJobCheckIntervalSeconds' in config) ? config.newJobCheckIntervalSeconds * second
      : ('newJobCheckInterval' in config) ? config.newJobCheckInterval
        : second * 2
}

function applyMaintenanceConfig (config) {
  assert(!('maintenanceIntervalSeconds' in config) || config.maintenanceIntervalSeconds >= 1,
    'configuration assert: maintenanceIntervalSeconds must be at least every second')

  assert(!('maintenanceIntervalMinutes' in config) || config.maintenanceIntervalMinutes >= 1,
    'configuration assert: maintenanceIntervalMinutes must be at least every minute')

  config.maintenanceIntervalSeconds =
    ('maintenanceIntervalMinutes' in config) ? config.maintenanceIntervalMinutes * 60
      : ('maintenanceIntervalSeconds' in config) ? config.maintenanceIntervalSeconds
        : 120
}

function applyArchiveConfig (config) {
  assert(!('archiveIntervalSeconds' in config) || config.archiveIntervalSeconds >= 1,
    'configuration assert: archiveIntervalSeconds must be at least every second')

  assert(!('archiveIntervalMinutes' in config) || config.archiveIntervalMinutes >= 1,
    'configuration assert: archiveIntervalMinutes must be at least every minute')

  assert(!('archiveIntervalHours' in config) || config.archiveIntervalHours >= 1,
    'configuration assert: archiveIntervalHours must be at least every hour')

  assert(!('archiveIntervalDays' in config) || config.archiveIntervalDays >= 1,
    'configuration assert: archiveIntervalDays must be at least every day')

  const archiveInterval =
    ('archiveIntervalDays' in config) ? `${config.archiveIntervalDays} days`
      : ('archiveIntervalHours' in config) ? `${config.archiveIntervalHours} hours`
        : ('archiveIntervalMinutes' in config) ? `${config.archiveIntervalMinutes} minutes`
          : ('archiveIntervalSeconds' in config) ? `${config.archiveIntervalSeconds} seconds`
            : '1 hour'

  config.archiveInterval = archiveInterval
}

function applyDeleteConfig (config) {
  assert(!('deleteIntervalSeconds' in config) || config.deleteIntervalSeconds >= 1,
    'configuration assert: deleteIntervalSeconds must be at least every second')

  assert(!('deleteIntervalMinutes' in config) || config.deleteIntervalMinutes >= 1,
    'configuration assert: deleteIntervalMinutes must be at least every minute')

  assert(!('deleteIntervalHours' in config) || config.deleteIntervalHours >= 1,
    'configuration assert: deleteIntervalHours must be at least every hour')

  assert(!('deleteIntervalDays' in config) || config.deleteIntervalDays >= 1,
    'configuration assert: deleteIntervalDays must be at least every day')

  const deleteInterval =
    ('deleteIntervalDays' in config) ? `${config.deleteIntervalDays} days`
      : ('deleteIntervalHours' in config) ? `${config.deleteIntervalHours} hours`
        : ('deleteIntervalMinutes' in config) ? `${config.deleteIntervalMinutes} minutes`
          : ('deleteIntervalSeconds' in config) ? `${config.deleteIntervalSeconds} seconds`
            : '7 days'

  config.deleteInterval = deleteInterval
}

function applyMonitoringConfig (config) {
  assert(!('monitorStateIntervalSeconds' in config) || config.monitorStateIntervalSeconds >= 1,
    'configuration assert: monitorStateIntervalSeconds must be at least every second')

  assert(!('monitorStateIntervalMinutes' in config) || config.monitorStateIntervalMinutes >= 1,
    'configuration assert: monitorStateIntervalMinutes must be at least every minute')

  config.monitorStateIntervalSeconds =
    ('monitorStateIntervalMinutes' in config) ? config.monitorStateIntervalMinutes * 60
      : ('monitorStateIntervalSeconds' in config) ? config.monitorStateIntervalSeconds
        : null
}

function applyUuidConfig (config) {
  assert(!('uuid' in config) || config.uuid === 'v1' || config.uuid === 'v4', 'configuration assert: uuid option only supports v1 or v4')
  config.uuid = config.uuid || 'v1'
}
