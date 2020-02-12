const assert = require('assert')

const second = 1000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour

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
    ('newJobCheckIntervalSeconds' in config) ? config.newJobCheckIntervalSeconds * second
      : ('newJobCheckInterval' in config) ? config.newJobCheckInterval
        : second
}

function applyMaintenanceConfig (config) {
  assert(!('maintenanceIntervalSeconds' in config) || config.maintenanceIntervalSeconds >= 1,
    'configuration assert: maintenanceIntervalSeconds must be at least every second')

  assert(!('maintenanceIntervalMinutes' in config) || config.maintenanceIntervalMinutes >= 1,
    'configuration assert: maintenanceIntervalMinutes must be at least every minute')

  config.maintenanceInterval =
    ('maintenanceIntervalMinutes' in config) ? config.maintenanceIntervalMinutes * minute
      : ('maintenanceIntervalSeconds' in config) ? config.maintenanceIntervalSeconds * second
        : minute
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
    ('archiveIntervalDays' in config) ? config.archiveIntervalDays * day
      : ('archiveIntervalHours' in config) ? config.archiveIntervalHours * hour
        : ('archiveIntervalMinutes' in config) ? config.archiveIntervalMinutes * minute
          : ('archiveIntervalSeconds' in config) ? config.archiveIntervalSeconds * second
            : hour

  // convert to string to be used as a pg interval arg
  config.archiveInterval = `${archiveInterval}ms`
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
    ('deleteIntervalDays' in config) ? config.deleteIntervalDays * day
      : ('deleteIntervalHours' in config) ? config.deleteIntervalHours * hour
        : ('deleteIntervalMinutes' in config) ? config.deleteIntervalMinutes * minute
          : ('deleteIntervalSeconds' in config) ? config.deleteIntervalSeconds * second
            : 7 * day

  // convert to string to be used as a pg interval arg
  config.deleteInterval = `${deleteInterval}ms`
}

function applyMonitoringConfig (config) {
  assert(!('monitorStateIntervalSeconds' in config) || config.monitorStateIntervalSeconds >= 1,
    'configuration assert: monitorStateIntervalSeconds must be at least every second')

  assert(!('monitorStateIntervalMinutes' in config) || config.monitorStateIntervalMinutes >= 1,
    'configuration assert: monitorStateIntervalMinutes must be at least every minute')

  config.monitorStateInterval =
    ('monitorStateIntervalMinutes' in config) ? config.monitorStateIntervalMinutes * minute
      : ('monitorStateIntervalSeconds' in config) ? config.monitorStateIntervalSeconds * second
        : null
}

function applyUuidConfig (config) {
  assert(!('uuid' in config) || config.uuid === 'v1' || config.uuid === 'v4', 'configuration assert: uuid option only supports v1 or v4')
  config.uuid = config.uuid || 'v1'
}
