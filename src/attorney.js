const assert = require('assert')

module.exports = {
  getConfig,
  applyNewJobCheckInterval,
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

  return { name, data, options: { ...options } }
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
  }

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

function applyNewJobCheckInterval (config) {
  assert(!('newJobCheckInterval' in config) || config.newJobCheckInterval >= 100,
    'configuration assert: newJobCheckInterval must be at least every 100ms')

  assert(!('newJobCheckIntervalSeconds' in config) || config.newJobCheckIntervalSeconds >= 1,
    'configuration assert: newJobCheckIntervalSeconds must be at least every second')

  config.newJobCheckInterval =
    ('newJobCheckIntervalSeconds' in config) ? config.newJobCheckIntervalSeconds * 1000
      : ('newJobCheckInterval' in config) ? config.newJobCheckInterval
        : 1000 // default is 1 second
}

function applyMaintenanceConfig (config) {
  assert(!('maintenanceIntervalSeconds' in config) || config.maintenanceIntervalSeconds >= 1,
    'configuration assert: maintenanceIntervalSeconds must be at least every second')

  assert(!('maintenanceIntervalMinutes' in config) || config.maintenanceIntervalMinutes >= 1,
    'configuration assert: maintenanceIntervalMinutes must be at least every minute')

  config.maintenanceInterval =
    ('maintenanceIntervalMinutes' in config) ? config.maintenanceIntervalMinutes * 60 * 1000
    // backing interval down a second to offset the internal subscription's fetch interval
      : ('maintenanceIntervalSeconds' in config) ? (config.maintenanceIntervalSeconds - 1) * 1000
        : 60 * 1000 // default is 1 minute
}

function applyArchiveConfig (config) {
  assert(!('archiveCompletedJobsEvery' in config) || typeof config.archiveCompletedJobsEvery === 'string',
    'configuration assert: archiveCompletedJobsEvery should be a readable PostgreSQL interval such as "1 day"')

  config.archiveCompletedJobsEvery = config.archiveCompletedJobsEvery || '1 hour'
}

function applyDeleteConfig (config) {
  // TODO: discontinue pg interval strings in favor of ms int for better validation (when interval is specified lower than check interval, for example)
  assert(!('deleteArchivedJobsEvery' in config) || typeof config.deleteArchivedJobsEvery === 'string',
    'configuration assert: deleteArchivedJobsEvery should be a readable PostgreSQL interval such as "7 days"')

  config.deleteArchivedJobsEvery = config.deleteArchivedJobsEvery || '7 days'
}

function applyMonitoringConfig (config) {
  assert(!('monitorStateIntervalSeconds' in config) || config.monitorStateIntervalSeconds >= 1,
    'configuration assert: monitorStateIntervalSeconds must be at least every second')

  assert(!('monitorStateIntervalMinutes' in config) || config.monitorStateIntervalMinutes >= 1,
    'configuration assert: monitorStateIntervalMinutes must be at least every minute')

  config.monitorStateInterval =
    ('monitorStateIntervalMinutes' in config) ? config.monitorStateIntervalMinutes * 60 * 1000
      // backing interval down a second to offset the internal subscription's fetch interval
      : ('monitorStateIntervalSeconds' in config) ? (config.monitorStateIntervalSeconds - 1) * 1000
        : null
}

function applyUuidConfig (config) {
  assert(!('uuid' in config) || config.uuid === 'v1' || config.uuid === 'v4', 'configuration assert: uuid option only supports v1 or v4')
  config.uuid = config.uuid || 'v1'
}
