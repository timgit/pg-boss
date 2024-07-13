const assert = require('assert')

const states = {
  created: 'created',
  retry: 'retry',
  active: 'active',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed'
}

const DEFAULT_SCHEMA = 'pgboss'
const MIGRATE_RACE_MESSAGE = 'division by zero'
const CREATE_RACE_MESSAGE = 'already exists'

const QUEUE_POLICY = {
  standard: 'standard',
  short: 'short',
  singleton: 'singleton',
  stately: 'stately'
}

module.exports = {
  create,
  insertVersion,
  getVersion,
  setVersion,
  versionTableExists,
  fetchNextJob,
  completeJobs,
  cancelJobs,
  resumeJobs,
  failJobsById,
  failJobsByTimeout,
  insertJob,
  insertJobs,
  getTime,
  getSchedules,
  schedule,
  unschedule,
  subscribe,
  unsubscribe,
  getQueuesForEvent,
  archive,
  drop,
  countStates,
  createQueue,
  updateQueue,
  createPartition,
  dropPartition,
  deleteQueueRecords,
  getQueueByName,
  getQueueSize,
  purgeQueue,
  clearStorage,
  getMaintenanceTime,
  setMaintenanceTime,
  getMonitorTime,
  setMonitorTime,
  getCronTime,
  setCronTime,
  locked,
  advisoryLock,
  assertMigration,
  getArchivedJobById,
  getJobById,
  QUEUE_POLICY,
  states: { ...states },
  MIGRATE_RACE_MESSAGE,
  CREATE_RACE_MESSAGE,
  DEFAULT_SCHEMA
}

function create (schema, version) {
  const commands = [
    createSchema(schema),
    createEnumJobState(schema),

    createTableJob(schema),
    createIndexJobName(schema),
    createIndexJobFetch(schema),
    createIndexJobPolicyStately(schema),
    createIndexJobPolicyShort(schema),
    createIndexJobPolicySingleton(schema),
    createIndexJobThrottleOn(schema),
    createIndexJobThrottleKey(schema),

    createTableArchive(schema),
    createPrimaryKeyArchive(schema),
    createColumnArchiveArchivedOn(schema),
    createIndexArchiveArchivedOn(schema),
    createIndexArchiveName(schema),

    createTableVersion(schema),
    createTableQueue(schema),
    createTableSchedule(schema),
    createTableSubscription(schema),

    getPartitionFunction(schema),
    createPartitionFunction(schema),
    dropPartitionFunction(schema),

    insertVersion(schema, version)
  ]

  return locked(schema, commands)
}

function createSchema (schema) {
  return `
    CREATE SCHEMA IF NOT EXISTS ${schema}
  `
}

function createTableVersion (schema) {
  return `
    CREATE TABLE ${schema}.version (
      version int primary key,
      maintained_on timestamp with time zone,
      cron_on timestamp with time zone,
      monitored_on timestamp with time zone
    )
  `
}

function createEnumJobState (schema) {
  // ENUM definition order is important
  // base type is numeric and first values are less than last values
  return `
    CREATE TYPE ${schema}.job_state AS ENUM (
      '${states.created}',
      '${states.retry}',
      '${states.active}',
      '${states.completed}',
      '${states.cancelled}',
      '${states.failed}'
    )
  `
}

function createTableJob (schema) {
  return `
    CREATE TABLE ${schema}.job (
      id uuid not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state ${schema}.job_state not null default('${states.created}'),
      retryLimit integer not null default(0),
      retryCount integer not null default(0),
      retryDelay integer not null default(0),
      retryBackoff boolean not null default false,
      startAfter timestamp with time zone not null default now(),
      startedOn timestamp with time zone,
      singletonKey text,
      singletonOn timestamp without time zone,
      expireIn interval not null default interval '15 minutes',
      createdOn timestamp with time zone not null default now(),
      completedOn timestamp with time zone,
      keepUntil timestamp with time zone NOT NULL default now() + interval '14 days',
      output jsonb,
      deadletter text,
      policy text,
      CONSTRAINT job_pkey PRIMARY KEY (name, id)
    ) PARTITION BY LIST (name)
  `
}

function createPartition (schema, name) {
  return `SELECT ${schema}.create_partition('${name}');`
}

function getPartitionFunction (schema) {
  return `
    CREATE FUNCTION ${schema}.get_partition(queue_name text, out name text) AS
    $$
    SELECT '${schema}.j' || encode(digest(queue_name, 'sha1'), 'hex');
    $$
    LANGUAGE SQL
    IMMUTABLE
  `
}

function createPartitionFunction (schema) {
  return `
    CREATE FUNCTION ${schema}.create_partition(queue_name text)
    RETURNS VOID AS
    $$
    DECLARE
      table_name varchar := ${schema}.get_partition(queue_name);
    BEGIN
      EXECUTE format('CREATE TABLE %I (LIKE ${schema}.job INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', table_name);
      EXECUTE format('ALTER TABLE %I ADD CHECK (name=%L)', table_name, queue_name);
      EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION %I FOR VALUES IN (%L)', table_name, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `
}

function dropPartitionFunction (schema) {
  return `
    CREATE FUNCTION ${schema}.drop_partition(queue_name text)
    RETURNS VOID AS
    $$
    BEGIN  
      EXECUTE format('DROP TABLE IF EXISTS %I', ${schema}.get_partition(queue_name));
    END;
    $$
    LANGUAGE plpgsql;
  `
}

function dropPartition (schema, name) {
  return `SELECT ${schema}.drop_partition('${name}');`
}

function createPrimaryKeyArchive (schema) {
  return `ALTER TABLE ${schema}.archive ADD CONSTRAINT archive_pkey PRIMARY KEY (name, id)`
}

function createIndexJobPolicyShort (schema) {
  return `CREATE UNIQUE INDEX job_policy_short ON ${schema}.job (name) WHERE state = '${states.created}' AND policy = '${QUEUE_POLICY.short}'`
}

function createIndexJobPolicySingleton (schema) {
  return `CREATE UNIQUE INDEX job_policy_singleton ON ${schema}.job (name) WHERE state = '${states.active}' AND policy = '${QUEUE_POLICY.singleton}'`
}

function createIndexJobPolicyStately (schema) {
  return `CREATE UNIQUE INDEX job_policy_stately ON ${schema}.job (name, state) WHERE state <= '${states.active}' AND policy = '${QUEUE_POLICY.stately}'`
}

function createIndexJobThrottleOn (schema) {
  return `CREATE UNIQUE INDEX job_throttle_on ON ${schema}.job (name, singletonOn, COALESCE(singletonKey, '')) WHERE state <= '${states.completed}' AND singletonOn IS NOT NULL`
}

function createIndexJobThrottleKey (schema) {
  return `CREATE UNIQUE INDEX job_throttle_key ON ${schema}.job (name, singletonKey) WHERE state <= '${states.completed}' AND singletonOn IS NULL`
}

function createIndexJobName (schema) {
  return `CREATE INDEX job_name ON ${schema}.job (name)`
}

function createIndexJobFetch (schema) {
  return `CREATE INDEX job_fetch ON ${schema}.job (name, startAfter) INCLUDE (priority, createdOn, id) WHERE state < '${states.active}'`
}

function createTableArchive (schema) {
  return `CREATE TABLE ${schema}.archive (LIKE ${schema}.job)`
}

function createColumnArchiveArchivedOn (schema) {
  return `ALTER TABLE ${schema}.archive ADD archivedOn timestamptz NOT NULL DEFAULT now()`
}

function createIndexArchiveArchivedOn (schema) {
  return `CREATE INDEX archive_archivedon_idx ON ${schema}.archive(archivedon)`
}

function createIndexArchiveName (schema) {
  return `CREATE INDEX archive_name_idx ON ${schema}.archive(name)`
}

function getMaintenanceTime (schema) {
  return `SELECT maintained_on, EXTRACT( EPOCH FROM (now() - maintained_on) ) seconds_ago FROM ${schema}.version`
}

function setMaintenanceTime (schema) {
  return `UPDATE ${schema}.version SET maintained_on = now()`
}

function getMonitorTime (schema) {
  return `SELECT monitored_on, EXTRACT( EPOCH FROM (now() - monitored_on) ) seconds_ago FROM ${schema}.version`
}

function setMonitorTime (schema) {
  return `UPDATE ${schema}.version SET monitored_on = now()`
}

function setCronTime (schema, time) {
  time = time || 'now()'
  return `UPDATE ${schema}.version SET cron_on = ${time}`
}

function getCronTime (schema) {
  return `SELECT cron_on, EXTRACT( EPOCH FROM (now() - cron_on) ) seconds_ago FROM ${schema}.version`
}

function createQueue (schema) {
  return `
    INSERT INTO ${schema}.queue (name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds, retention_minutes, dead_letter)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `
}

function updateQueue (schema) {
  return `
    UPDATE ${schema}.queue SET
      retry_limit = COALESCE($2, retry_limit),
      retry_delay = COALESCE($3, retry_delay),
      retry_backoff = COALESCE($4, retry_backoff),
      expire_seconds = COALESCE($5, expire_seconds),
      retention_minutes = COALESCE($6, retention_minutes),
      dead_letter = COALESCE($7, dead_letter)
    WHERE name = $1
  `
}

function getQueueByName (schema) {
  return `SELECT * FROM ${schema}.queue WHERE name = $1`
}

function deleteQueueRecords (schema) {
  return `WITH dq AS (
      DELETE FROM ${schema}.queue WHERE name = $1
    )
    DELETE FROM ${schema}.job WHERE name = $1
  `
}

function purgeQueue (schema) {
  return `DELETE from ${schema}.job WHERE name = $1 and state < '${states.active}'`
}

function clearStorage (schema) {
  return `TRUNCATE ${schema}.job, ${schema}.archive`
}

function getQueueSize (schema, options = {}) {
  options.before = options.before || states.active
  assert(options.before in states, `${options.before} is not a valid state`)
  return `SELECT count(*) as count FROM ${schema}.job WHERE name = $1 AND state < '${options.before}'`
}

function createTableQueue (schema) {
  return `
    CREATE TABLE ${schema}.queue (
      name text primary key,
      policy text,
      retry_limit int,
      retry_delay int,
      retry_backoff bool,
      expire_seconds int,
      retention_minutes int,
      dead_letter text,
      created_on timestamp with time zone not null default now()
    )
  `
}

function createTableSchedule (schema) {
  return `
    CREATE TABLE ${schema}.schedule (
      name text primary key,
      cron text not null,
      timezone text,
      data jsonb,
      options jsonb,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now()
    )
  `
}

function createTableSubscription (schema) {
  return `
    CREATE TABLE ${schema}.subscription (
      event text not null,
      name text not null,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY(event, name)
    )
  `
}

function getSchedules (schema) {
  return `
    SELECT * FROM ${schema}.schedule
  `
}

function schedule (schema) {
  return `
    INSERT INTO ${schema}.schedule (name, cron, timezone, data, options)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (name) DO UPDATE SET
      cron = EXCLUDED.cron,
      timezone = EXCLUDED.timezone,
      data = EXCLUDED.data,
      options = EXCLUDED.options,
      updated_on = now()
  `
}

function unschedule (schema) {
  return `
    DELETE FROM ${schema}.schedule
    WHERE name = $1
  `
}

function subscribe (schema) {
  return `
    INSERT INTO ${schema}.subscription (event, name)
    VALUES ($1, $2)
    ON CONFLICT (event, name) DO UPDATE SET
      event = EXCLUDED.event,
      name = EXCLUDED.name,
      updated_on = now()
  `
}

function unsubscribe (schema) {
  return `
    DELETE FROM ${schema}.subscription
    WHERE event = $1 and name = $2
  `
}

function getQueuesForEvent (schema) {
  return `
    SELECT name FROM ${schema}.subscription
    WHERE event = $1
  `
}

function getTime () {
  return "SELECT round(date_part('epoch', now()) * 1000) as time"
}

function getVersion (schema) {
  return `SELECT version from ${schema}.version`
}

function setVersion (schema, version) {
  return `UPDATE ${schema}.version SET version = '${version}'`
}

function versionTableExists (schema) {
  return `SELECT to_regclass('${schema}.version') as name`
}

function insertVersion (schema, version) {
  return `INSERT INTO ${schema}.version(version) VALUES ('${version}')`
}

function fetchNextJob (schema) {
  return ({ includeMetadata, priority = true } = {}) => `
    WITH next as (
      SELECT id
      FROM ${schema}.job
      WHERE name = $1
        AND state < '${states.active}'
        AND startAfter < now()
      ORDER BY ${priority && 'priority desc, '} createdOn, id
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${schema}.job j SET
      state = '${states.active}',
      startedOn = now(),
      retryCount = CASE WHEN startedOn IS NOT NULL THEN retryCount + 1 ELSE retryCount END
    FROM next
    WHERE name = $1 AND j.id = next.id
    RETURNING ${includeMetadata ? 'j.*' : 'j.id, name, data'}, 
      EXTRACT(epoch FROM expireIn) as expire_in_seconds
  `
}

function completeJobs (schema) {
  return `
    WITH results AS (
      UPDATE ${schema}.job
      SET completedOn = now(),
        state = '${states.completed}',
        output = $3::jsonb
      WHERE name = $1
        AND id IN (SELECT UNNEST($2::uuid[]))
        AND state = '${states.active}'
      RETURNING *
    )
    SELECT COUNT(*) FROM results
  `
}

function failJobsById (schema) {
  const where = `name = $1 AND id IN (SELECT UNNEST($2::uuid[])) AND state < '${states.completed}'`
  const output = '$3::jsonb'

  return failJobs(schema, where, output)
}

function failJobsByTimeout (schema) {
  const where = `state = '${states.active}' AND (startedOn + expireIn) < now()`
  const output = '\'{ "value": { "message": "job failed by timeout in active state" } }\'::jsonb'
  return failJobs(schema, where, output)
}

function failJobs (schema, where, output) {
  return `
    WITH results AS (
      UPDATE ${schema}.job SET
        state = CASE
          WHEN retryCount < retryLimit THEN '${states.retry}'::${schema}.job_state
          ELSE '${states.failed}'::${schema}.job_state
          END,
        completedOn = CASE
          WHEN retryCount < retryLimit THEN NULL
          ELSE now()
          END,
        startAfter = CASE
          WHEN retryCount = retryLimit THEN startAfter
          WHEN NOT retryBackoff THEN now() + retryDelay * interval '1'
          ELSE now() + (
                retryDelay * 2 ^ LEAST(16, retryCount + 1) / 2 +
                retryDelay * 2 ^ LEAST(16, retryCount + 1) / 2 * random()
            ) * interval '1'
          END,
        output = ${output}
      WHERE ${where}
      RETURNING *
    ), dlq_jobs as (
      INSERT INTO ${schema}.job (name, data, output, retryLimit, keepUntil)
      SELECT
        deadletter,
        data,
        output,
        retryLimit,
        keepUntil + (keepUntil - startAfter)
      FROM results
      WHERE state = '${states.failed}'
        AND deadletter IS NOT NULL
        AND NOT name = deadletter
    )
    SELECT COUNT(*) FROM results
  `
}

function cancelJobs (schema) {
  return `
    with results as (
      UPDATE ${schema}.job
      SET completedOn = now(),
        state = '${states.cancelled}'
      WHERE name = $1
        AND id IN (SELECT UNNEST($2::uuid[]))
        AND state < '${states.completed}'
      RETURNING 1
    )
    SELECT COUNT(*) from results
  `
}

function resumeJobs (schema) {
  return `
    with results as (
      UPDATE ${schema}.job
      SET completedOn = NULL,
        state = '${states.created}'
      WHERE name = $1
        AND id IN (SELECT UNNEST($2::uuid[]))
      RETURNING 1
    )
    SELECT COUNT(*) from results
  `
}

function insertJob (schema) {
  return `
    INSERT INTO ${schema}.job (
      id,
      name,
      data,
      priority,
      startAfter,
      singletonKey,
      singletonOn,
      deadletter,
      expireIn,
      keepUntil,
      retryLimit,
      retryDelay,
      retryBackoff,
      policy
    )
    SELECT
      id,
      j.name,
      data,
      priority,
      startAfter,
      singletonKey,
      singletonOn,
      COALESCE(deadLetter, q.dead_letter) as deadletter,
      CASE
        WHEN expireIn IS NOT NULL THEN CAST(expireIn as interval)
        WHEN q.expire_seconds IS NOT NULL THEN q.expire_seconds * interval '1s'
        WHEN expireInDefault IS NOT NULL THEN CAST(expireInDefault as interval)
        ELSE interval '15 minutes'
        END as expireIn,
      CASE
        WHEN right(keepUntil, 1) = 'Z' THEN CAST(keepUntil as timestamp with time zone)
        ELSE startAfter + CAST(COALESCE(keepUntil, (q.retention_minutes * 60)::text, keepUntilDefault, '14 days') as interval)
        END as keepUntil,
      COALESCE(retryLimit, q.retry_limit, retryLimitDefault, 2) as retryLimit,
      CASE
        WHEN COALESCE(retryBackoff, q.retry_backoff, retryBackoffDefault, false)
        THEN GREATEST(COALESCE(retryDelay, q.retry_delay, retryDelayDefault), 1)
        ELSE COALESCE(retryDelay, q.retry_delay, retryDelayDefault, 0)
        END as retryDelay,
      COALESCE(retryBackoff, q.retry_backoff, retryBackoffDefault, false) as retryBackoff,
      q.policy
    FROM
      ( SELECT
          COALESCE($1::uuid, gen_random_uuid()) as id,
          $2 as name,
          $3::jsonb as data,
          COALESCE($4::int, 0) as priority,
          CASE
            WHEN right($5, 1) = 'Z' THEN CAST($5 as timestamp with time zone)
            ELSE now() + CAST(COALESCE($5,'0') as interval)
            END as startAfter,
          $6 as singletonKey,
          CASE
            WHEN $7::integer IS NOT NULL THEN 'epoch'::timestamp + '1 second'::interval * ($7 * floor((date_part('epoch', now()) + $8) / $7))
            ELSE NULL
            END as singletonOn,
          $9 as deadletter,
          $10 as expireIn,
          $11 as expireInDefault,
          $12 as keepUntil,
          $13 as keepUntilDefault,
          $14::int as retryLimit,
          $15::int as retryLimitDefault,
          $16::int as retryDelay,
          $17::int as retryDelayDefault,
          $18::bool as retryBackoff,
          $19::bool as retryBackoffDefault
      ) j LEFT JOIN ${schema}.queue q ON j.name = q.name
    ON CONFLICT DO NOTHING
    RETURNING id
  `
}

function insertJobs (schema) {
  return `
    WITH defaults as (
      SELECT 
        $2 as expireIn,
        $3 as keepUntil,
        $4::int as retryLimit,
        $5::int as retryDelay,
        $6::bool as retryBackoff
    )
    INSERT INTO ${schema}.job (
      id,
      name,
      data,
      priority,
      startAfter,
      singletonKey,
      deadletter,
      expireIn,
      keepUntil,
      retryLimit,
      retryDelay,
      retryBackoff,
      policy
    )
    SELECT
      COALESCE(id, gen_random_uuid()) as id,
      j.name,
      data,
      COALESCE(priority, 0),
      COALESCE("startAfter", now()),
      "singletonKey",
      COALESCE("deadLetter", q.dead_letter),
      CASE
        WHEN "expireInSeconds" IS NOT NULL THEN "expireInSeconds" *  interval '1s'
        WHEN q.expire_seconds IS NOT NULL THEN q.expire_seconds * interval '1s'
        WHEN defaults.expireIn IS NOT NULL THEN CAST(defaults.expireIn as interval)
        ELSE interval '15 minutes'
        END as expireIn,
      CASE
        WHEN "keepUntil" IS NOT NULL THEN "keepUntil"
        ELSE COALESCE("startAfter", now()) + CAST(COALESCE((q.retention_minutes * 60)::text, defaults.keepUntil, '14 days') as interval)
        END as keepUntil,
      COALESCE("retryLimit", q.retry_limit, defaults.retryLimit, 2),
      CASE
        WHEN COALESCE("retryBackoff", q.retry_backoff, defaults.retryBackoff, false)
          THEN GREATEST(COALESCE("retryDelay", q.retry_delay, defaults.retryDelay), 1)
        ELSE COALESCE("retryDelay", q.retry_delay, defaults.retryDelay, 0)
        END as retryDelay,      
      COALESCE("retryBackoff", q.retry_backoff, defaults.retryBackoff, false) as retryBackoff,
      q.policy
    FROM json_to_recordset($1) as j (
      id uuid,
      name text,
      priority integer,
      data jsonb,
      "startAfter" timestamp with time zone,
      "retryLimit" integer,
      "retryDelay" integer,
      "retryBackoff" boolean,
      "singletonKey" text,
      "expireInSeconds" integer,
      "keepUntil" timestamp with time zone,
      "deadLetter" text
    )
    LEFT JOIN ${schema}.queue q ON j.name = q.name,
      defaults
    ON CONFLICT DO NOTHING
  `
}

function drop (schema, interval) {
  return `
    DELETE FROM ${schema}.archive
    WHERE archivedOn < (now() - interval '${interval}')
  `
}

function archive (schema, completedInterval, failedInterval = completedInterval) {
  return `
    WITH archived_rows AS (
      DELETE FROM ${schema}.job
      WHERE (state <> '${states.failed}' AND completedOn < (now() - interval '${completedInterval}'))
        OR (state = '${states.failed}' AND completedOn < (now() - interval '${failedInterval}'))
        OR (state < '${states.active}' AND keepUntil < now())
      RETURNING *
    )
    INSERT INTO ${schema}.archive (
      id, name, priority, data, state, retryLimit, retryCount, retryDelay, retryBackoff, startAfter, startedOn, singletonKey, singletonOn, expireIn, createdOn, completedOn, keepUntil, deadletter, policy, output
    )
    SELECT
      id, name, priority, data, state, retryLimit, retryCount, retryDelay, retryBackoff, startAfter, startedOn, singletonKey, singletonOn, expireIn, createdOn, completedOn, keepUntil, deadletter, policy, output
    FROM archived_rows
  `
}

function countStates (schema) {
  return `
    SELECT name, state, count(*) size
    FROM ${schema}.job
    GROUP BY rollup(name), rollup(state)
  `
}

function locked (schema, query) {
  if (Array.isArray(query)) {
    query = query.join(';\n')
  }

  return `
    BEGIN;
    SET LOCAL lock_timeout = '30s';
    ${advisoryLock(schema)};
    ${query};
    COMMIT;
  `
}

function advisoryLock (schema, key) {
  return `SELECT pg_advisory_xact_lock(      
      ('x' || encode(digest(current_database() || '.pgboss.${schema}${key || ''}', 'sha256'), 'hex'))::bit(64)::bigint
  )`
}

function assertMigration (schema, version) {
  // raises 'division by zero' if already on desired schema version
  return `SELECT version::int/(version::int-${version}) from ${schema}.version`
}

function getJobById (schema) {
  return getJobByTableAndId(schema, 'job')
}

function getArchivedJobById (schema) {
  return getJobByTableAndId(schema, 'archive')
}

function getJobByTableAndId (schema, table) {
  return `SELECT * FROM ${schema}.${table} WHERE name = $1 AND id = $2`
}
