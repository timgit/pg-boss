const assert = require('assert');

module.exports = {
  applyConfig,
  applyNewJobCheckInterval
};

function applyConfig(config) {

  assert(config && (typeof config == 'object' || typeof config == 'string'),
    'configuration assert: string or config object is required to connect to postgres');

  config = applyDatabaseConfig(config);
  config = applyNewJobCheckInterval(config);
  config = applyExpireConfig(config);
  config = applyArchiveConfig(config);
  config = applyUuidConfig(config);

  return config;

}

function applyDatabaseConfig(config) {

  if(typeof config == 'string') {
    config = {connectionString: config};
  }
  else if ('connectionString' in config) {
    assert(typeof config.connectionString == 'string', 'configuration assert: connectionString must be a string');
  }
  else {
    assert(config.database && config.user && 'password' in config,
      'configuration assert: not enough database settings to connect to PostgreSQL');

    config.host = config.host || '127.0.0.1';
    config.port = config.port || 5432;
  }

  if(config.schema){
    assert(typeof config.schema == 'string', 'configuration assert: schema must be a string');
    assert(config.schema.length <= 50, 'configuration assert: schema name cannot exceed 50 characters');
    assert(!/\W/.test(config.schema), `configuration assert: ${config.schema} cannot be used as a schema. Only alphanumeric characters and underscores are allowed`);
  }

  config.schema = config.schema || 'pgboss';

  assert(!('poolSize' in config) || config.poolSize >=1,
    'configuration assert: poolSize must be at least 1');

  config.poolSize = config.poolSize || 10;

  return config;
}

function applyNewJobCheckInterval(config) {
  assert(!('newJobCheckInterval' in config) || config.newJobCheckInterval >=100,
    'configuration assert: newJobCheckInterval must be at least every 100ms');

  assert(!('newJobCheckIntervalSeconds' in config) || config.newJobCheckIntervalSeconds >=1,
    'configuration assert: newJobCheckIntervalSeconds must be at least every second');

  config.newJobCheckInterval =
    ('newJobCheckIntervalSeconds' in config) ? config.newJobCheckIntervalSeconds * 1000
      : ('newJobCheckInterval' in config) ? config.newJobCheckInterval
        : 1000; // default is 1 second

  return config;
}

function applyExpireConfig(config){
  assert(!('expireCheckInterval' in config) || config.expireCheckInterval >=100,
    'configuration assert: expireCheckInterval must be at least every 100ms');

  assert(!('expireCheckIntervalSeconds' in config) || config.expireCheckIntervalSeconds >=1,
    'configuration assert: expireCheckIntervalSeconds must be at least every second');

  assert(!('expireCheckIntervalMinutes' in config) || config.expireCheckIntervalMinutes >=1,
    'configuration assert: expireCheckIntervalMinutes must be at least every minute');

  config.expireCheckInterval =
    ('expireCheckIntervalMinutes' in config) ? config.expireCheckIntervalMinutes * 60 * 1000
      : ('expireCheckIntervalSeconds' in config) ? config.expireCheckIntervalSeconds * 1000
        : ('expireCheckInterval' in config) ? config.expireCheckInterval
          : 60 * 1000; // default is 1 minute

  return config;
}

function applyArchiveConfig(config) {
  assert(!('archiveCheckInterval' in config) || config.archiveCheckInterval >=100,
    'configuration assert: archiveCheckInterval must be at least every 100ms');

  assert(!('archiveCheckIntervalSeconds' in config) || config.archiveCheckIntervalSeconds >=1,
    'configuration assert: archiveCheckIntervalSeconds must be at least every second');

  assert(!('archiveCheckIntervalMinutes' in config) || config.archiveCheckIntervalMinutes >=1,
    'configuration assert: archiveCheckIntervalMinutes must be at least every minute');

  config.archiveCheckInterval =
    ('archiveCheckIntervalMinutes' in config) ? config.archiveCheckIntervalMinutes * 60 * 1000
      : ('archiveCheckIntervalSeconds' in config) ? config.archiveCheckIntervalSeconds * 1000
        : ('archiveCheckInterval' in config) ? config.archiveCheckInterval
          : 60 * 60 * 1000; // default is 1 hour


  assert(!('archiveCompletedJobsEvery' in config) || typeof config.archiveCompletedJobsEvery == 'string',
    'configuration assert: archiveCompletedJobsEvery should be a readable PostgreSQL interval such as "1 day"');

  config.archiveCompletedJobsEvery = config.archiveCompletedJobsEvery || '1 day';

  return config;
}

function applyUuidConfig(config) {
  assert(!('uuid' in config) || config.uuid == 'v1' || config.uuid == 'v4', 'configuration assert: uuid option only supports v1 or v4');
  config.uuid = config.uuid || 'v1';

  return config;
}
