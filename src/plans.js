const states = {
  created: 'created',
  retry: 'retry',
  active: 'active',
  completed: 'completed',
  expired: 'expired',
  cancelled: 'cancelled',
  failed: 'failed'
}
const assert = require('assert')
const completedJobPrefix = `__state__${states.completed}__`

const MUTEX = 1337968055000
const MIGRATE_RACE_MESSAGE = 'division by zero'
const CREATE_RACE_MESSAGE = 'already exists'

module.exports = {
  create,
  insertVersion,
  getVersion,
  setVersion,
  versionTableExists,
  fetchNextJob,
  completeJobs,
  cancelJobs,
  failJobs,
  insertJob,
  getTime,
  getSchedules,
  schedule,
  unschedule,
  expire,
  archive,
  purge,
  countStates,
  deleteQueue,
  deleteAllQueues,
  clearStorage,
  getQueueSize,
  getMaintenanceTime,
  setMaintenanceTime,
  getCronTime,
  setCronTime,
  states: { ...states },
  completedJobPrefix,
  advisoryLock,
  assertMigration,
  MIGRATE_RACE_MESSAGE,
  CREATE_RACE_MESSAGE
}

function create (schema, version) {
  return [
    'BEGIN',
    advisoryLock(),
    createSchema(schema),
    createVersionTable(schema),
    createJobStateEnum(schema),
    createJobTable(schema),
    cloneJobTableForArchive(schema),
    createScheduleTable(schema),
    addIdIndexToArchive(schema),
    addArchivedOnToArchive(schema),
    addArchivedOnIndexToArchive(schema),
    createIndexJobName(schema),
    createIndexSingletonOn(schema),
    createIndexSingletonKeyOn(schema),
    createIndexSingletonKey(schema),
    insertVersion(schema, version),
    'COMMIT;'
  ].join(';\n')
}

function createSchema (schema) {
  return `
    CREATE SCHEMA ${schema}
  `
}

function createVersionTable (schema) {
  return `
    CREATE TABLE ${schema}.version (
      version int primary key,
      maintained_on timestamp with time zone,
      cron_on timestamp with time zone
    )
  `
}

function createJobStateEnum (schema) {
  // ENUM definition order is important
  // base type is numeric and first values are less than last values
  return `
    CREATE TYPE ${schema}.job_state AS ENUM (
      '${states.created}',
      '${states.retry}',
      '${states.active}',
      '${states.completed}',
      '${states.expired}',
      '${states.cancelled}',
      '${states.failed}'
    )
  `
}

function createJobTable (schema) {
  return `
    CREATE TABLE ${schema}.job (
      id uuid primary key not null default gen_random_uuid(),
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
      keepUntil timestamp with time zone NOT NULL default now() + interval '30 days'
    )
  `
}

function cloneJobTableForArchive (schema) {
  return `CREATE TABLE ${schema}.archive (LIKE ${schema}.job)`
}

function addArchivedOnToArchive (schema) {
  return `ALTER TABLE ${schema}.archive ADD archivedOn timestamptz NOT NULL DEFAULT now()`
}

function addArchivedOnIndexToArchive (schema) {
  return `CREATE INDEX archive_archivedon_idx ON ${schema}.archive(archivedon)`
}

function addIdIndexToArchive (schema) {
  return `CREATE INDEX archive_id_idx ON ${schema}.archive(id)`
}

function setMaintenanceTime (schema) {
  return `UPDATE ${schema}.version SET maintained_on = now()`
}

function getMaintenanceTime (schema) {
  return `SELECT maintained_on, EXTRACT( EPOCH FROM (now() - maintained_on) ) seconds_ago FROM ${schema}.version`
}

function setCronTime (schema, time) {
  time = time || 'now()'
  return `UPDATE ${schema}.version SET cron_on = ${time}`
}

function getCronTime (schema) {
  return `SELECT cron_on, EXTRACT( EPOCH FROM (now() - cron_on) ) seconds_ago FROM ${schema}.version`
}

function deleteQueue (schema, options = {}) {
  options.before = options.before || states.active
  assert(options.before in states, `${options.before} is not a valid state`)
  return `DELETE FROM ${schema}.job WHERE name = $1 and state < '${options.before}'`
}

function deleteAllQueues (schema, options = {}) {
  options.before = options.before || states.active
  assert(options.before in states, `${options.before} is not a valid state`)
  return `DELETE FROM ${schema}.job WHERE state < '${options.before}'`
}

function clearStorage (schema) {
  return `TRUNCATE ${schema}.job, ${schema}.archive`
}

function getQueueSize (schema, options = {}) {
  options.before = options.before || states.active
  assert(options.before in states, `${options.before} is not a valid state`)
  return `SELECT count(*) as count FROM ${schema}.job WHERE name = $1 AND state < '${options.before}'`
}

function createIndexSingletonKey (schema) {
  // anything with singletonKey means "only 1 job can be queued or active at a time"
  return `
    CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < '${states.completed}' AND singletonOn IS NULL
  `
}

function createIndexSingletonOn (schema) {
  // anything with singletonOn means "only 1 job within this time period, queued, active or completed"
  return `
    CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < '${states.expired}' AND singletonKey IS NULL
  `
}

function createIndexSingletonKeyOn (schema) {
  // anything with both singletonOn and singletonKey means "only 1 job within this time period with this key, queued, active or completed"
  return `
    CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < '${states.expired}'
  `
}

function createIndexJobName (schema) {
  return `
    CREATE INDEX job_name ON ${schema}.job (name text_pattern_ops)
  `
}

function createScheduleTable (schema) {
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
  return (includeMetadata) => `
    WITH nextJob as (
      SELECT id
      FROM ${schema}.job
      WHERE state < '${states.active}'
        AND name LIKE $1
        AND startAfter < now()
      ORDER BY priority desc, createdOn, id
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${schema}.job j SET
      state = '${states.active}',
      startedOn = now(),
      retryCount = CASE WHEN state = '${states.retry}' THEN retryCount + 1 ELSE retryCount END
    FROM nextJob
    WHERE j.id = nextJob.id
    RETURNING ${includeMetadata ? 'j.*' : 'j.id, name, data, expireIn'}
  `
}

function buildJsonCompletionObject (withResponse) {
  // job completion contract
  return `jsonb_build_object(
    'request', jsonb_build_object('id', id, 'name', name, 'data', data),
    'response', ${withResponse ? '$2::jsonb' : 'null'},
    'state', state,
    'retryCount', retryCount,
    'createdOn', createdOn,
    'startedOn', startedOn,
    'completedOn', completedOn,
    'failed', CASE WHEN state = '${states.completed}' THEN false ELSE true END
  )`
}

const retryCompletedOnCase = `CASE
          WHEN retryCount < retryLimit
          THEN NULL
          ELSE now()
          END`

const retryStartAfterCase = `CASE
          WHEN retryCount = retryLimit THEN startAfter
          WHEN NOT retryBackoff THEN now() + retryDelay * interval '1'
          ELSE now() +
            (
                retryDelay * 2 ^ LEAST(16, retryCount + 1) / 2
                +
                retryDelay * 2 ^ LEAST(16, retryCount + 1) / 2 * random()
            )
            * interval '1'
          END`

const keepUntilInheritance = 'keepUntil + (keepUntil - startAfter)'

function completeJobs (schema) {
  return `
    WITH results AS (
      UPDATE ${schema}.job
      SET completedOn = now(),
        state = '${states.completed}'
      WHERE id IN (SELECT UNNEST($1::uuid[]))
        AND state = '${states.active}'
      RETURNING *
    )
    INSERT INTO ${schema}.job (name, data, keepUntil)
    SELECT
      '${completedJobPrefix}' || name,
      ${buildJsonCompletionObject(true)},
      ${keepUntilInheritance}
    FROM results
    WHERE NOT name LIKE '${completedJobPrefix}%'
    RETURNING 1
  ` // returning 1 here just to count results against input array
}

function failJobs (schema) {
  return `
    WITH results AS (
      UPDATE ${schema}.job
      SET state = CASE
          WHEN retryCount < retryLimit
          THEN '${states.retry}'::${schema}.job_state
          ELSE '${states.failed}'::${schema}.job_state
          END,
        completedOn = ${retryCompletedOnCase},
        startAfter = ${retryStartAfterCase}
      WHERE id IN (SELECT UNNEST($1::uuid[]))
        AND state < '${states.completed}'
      RETURNING *
    )
    INSERT INTO ${schema}.job (name, data, keepUntil)
    SELECT
      '${completedJobPrefix}' || name,
      ${buildJsonCompletionObject(true)},
      ${keepUntilInheritance}
    FROM results
    WHERE state = '${states.failed}'
      AND NOT name LIKE '${completedJobPrefix}%'
    RETURNING 1
  ` // returning 1 here just to count results against input array
}

function expire (schema) {
  return `
    WITH results AS (
      UPDATE ${schema}.job
      SET state = CASE
          WHEN retryCount < retryLimit THEN '${states.retry}'::${schema}.job_state
          ELSE '${states.expired}'::${schema}.job_state
          END,
        completedOn = ${retryCompletedOnCase},
        startAfter = ${retryStartAfterCase}
      WHERE state = '${states.active}'
        AND (startedOn + expireIn) < now()
      RETURNING *
    )
    INSERT INTO ${schema}.job (name, data, keepUntil)
    SELECT
      '${completedJobPrefix}' || name,
      ${buildJsonCompletionObject()},
      ${keepUntilInheritance}
    FROM results
    WHERE state = '${states.expired}'
      AND NOT name LIKE '${completedJobPrefix}%'
  `
}

function cancelJobs (schema) {
  return `
    UPDATE ${schema}.job
    SET completedOn = now(),
      state = '${states.cancelled}'
    WHERE id IN (SELECT UNNEST($1::uuid[]))
      AND state < '${states.completed}'
    RETURNING 1
  ` // returning 1 here just to count results against input array
}

function insertJob (schema) {
  return `
    INSERT INTO ${schema}.job (
      id,
      name,
      priority,
      state,
      retryLimit,
      startAfter,
      expireIn,
      data,
      singletonKey,
      singletonOn,
      retryDelay,
      retryBackoff,
      keepUntil
    )
    SELECT
      id,
      name,
      priority,
      state,
      retryLimit,
      startAfter,
      expireIn,
      data,
      singletonKey,
      singletonOn,
      retryDelay,
      retryBackoff,
      keepUntil
    FROM
    ( SELECT *,
        CASE
          WHEN right(keepUntilValue, 1) = 'Z' THEN CAST(keepUntilValue as timestamp with time zone)
          ELSE startAfter + CAST(COALESCE(keepUntilValue,'0') as interval)
          END as keepUntil
      FROM
      ( SELECT *,
          CASE
            WHEN right(startAfterValue, 1) = 'Z' THEN CAST(startAfterValue as timestamp with time zone)
            ELSE now() + CAST(COALESCE(startAfterValue,'0') as interval)
            END as startAfter
        FROM
        ( SELECT
            $1::uuid as id,
            $2::text as name,
            $3::int as priority,
            '${states.created}'::${schema}.job_state as state,
            $4::int as retryLimit,
            $5::text as startAfterValue,
            CAST($6 as interval) as expireIn,
            $7::jsonb as data,
            $8::text as singletonKey,
            CASE
              WHEN $9::integer IS NOT NULL THEN 'epoch'::timestamp + '1 second'::interval * ($9 * floor((date_part('epoch', now()) + $10) / $9))
              ELSE NULL
              END as singletonOn,
            $11::int as retryDelay,
            $12::bool as retryBackoff,
            $13::text as keepUntilValue
        ) j1
      ) j2
    ) j3
    ON CONFLICT DO NOTHING
    RETURNING id
  `
}

function purge (schema) {
  return `
    DELETE FROM ${schema}.archive
    WHERE archivedOn < (now() - CAST($1 as interval))
  `
}

function archive (schema) {
  return `
    WITH archived_rows AS (
      DELETE FROM ${schema}.job
      WHERE
        completedOn < (now() - CAST($1 as interval))
        OR (
          state < '${states.active}' AND keepUntil < now()
        )
      RETURNING *
    )
    INSERT INTO ${schema}.archive (
      id, name, priority, data, state, retryLimit, retryCount, retryDelay, retryBackoff, startAfter, startedOn, singletonKey, singletonOn, expireIn, createdOn, completedOn, keepUntil
    )
    SELECT
      id, name, priority, data, state, retryLimit, retryCount, retryDelay, retryBackoff, startAfter, startedOn, singletonKey, singletonOn, expireIn, createdOn, completedOn, keepUntil
    FROM archived_rows
  `
}

function countStates (schema) {
  return `
    SELECT name, state, count(*) size
    FROM ${schema}.job
    WHERE name NOT LIKE '${completedJobPrefix}%'
    GROUP BY rollup(name), rollup(state)
  `
}

function advisoryLock () {
  return `SELECT pg_advisory_xact_lock(${MUTEX})`
}

function assertMigration (schema, version) {
  // raises 'division by zero' if already on desired schema version
  return `SELECT version::int/(version::int-${version}) from ${schema}.version`
}
