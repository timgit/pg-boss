const assert = require('assert')

const states = {
  created: 'created',
  retry: 'retry',
  active: 'active',
  completed: 'completed',
  expired: 'expired',
  cancelled: 'cancelled',
  failed: 'failed'
}

const DEFAULT_SCHEMA = 'pgboss'
const COMPLETION_JOB_PREFIX = `__state__${states.completed}__`
const SINGLETON_QUEUE_KEY = '__pgboss__singleton_queue'
const SINGLETON_QUEUE_KEY_ESCAPED = SINGLETON_QUEUE_KEY.replace(/_/g, '\\_')

const MIGRATE_RACE_MESSAGE = 'division by zero'
const CREATE_RACE_MESSAGE = 'already exists'

module.exports = {
  create,
  insertVersion,
  getVersion,
  setVersion,
  versionTableExists,
  fetchNextJob,
  cancelDuplicateJobs,
  completeJobs,
  cancelJobs,
  resumeJobs,
  failJobs,
  insertJob,
  insertJobs,
  getTime,
  getSchedules,
  schedule,
  unschedule,
  subscribe,
  unsubscribe,
  getQueuesForEvent,
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
  locked,
  assertMigration,
  getArchivedJobById,
  getJobById,
  states: { ...states },
  COMPLETION_JOB_PREFIX,
  SINGLETON_QUEUE_KEY,
  MIGRATE_RACE_MESSAGE,
  CREATE_RACE_MESSAGE,
  DEFAULT_SCHEMA
}

function locked (schema, query) {
  if (Array.isArray(query)) {
    query = query.join(';\n')
  }

  return `
    BEGIN;
    SET LOCAL statement_timeout = '30s';
    ${advisoryLock(schema)};
    ${query};
    COMMIT;
  `
}

function create (schema, version) {
  const commands = [
    createSchema(schema),
    createVersionTable(schema),
    createJobStateEnum(schema),
    createJobTable(schema),
    cloneJobTableForArchive(schema),
    createScheduleTable(schema),
    createSubscriptionTable(schema),
    addIdIndexToArchive(schema),
    addArchivedOnToArchive(schema),
    addArchivedOnIndexToArchive(schema),
    createIndexJobName(schema),
    createIndexJobFetch(schema),
    createIndexSingletonOn(schema),
    createIndexSingletonKeyOn(schema),
    createIndexSingletonKey(schema),
    createIndexSingletonQueue(schema),
    insertVersion(schema, version)
  ]

  return locked(schema, commands)
}

function createSchema (schema) {
  return `
    CREATE SCHEMA IF NOT EXISTS ${schema}
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
      keepUntil timestamp with time zone NOT NULL default now() + interval '14 days',
      on_complete boolean not null default false,
      output jsonb
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
    CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < '${states.completed}' AND singletonOn IS NULL AND NOT singletonKey LIKE '${SINGLETON_QUEUE_KEY_ESCAPED}%'
  `
}

function createIndexSingletonQueue (schema) {
  // "singleton queue" means "only 1 job can be queued at a time"
  return `
    CREATE UNIQUE INDEX job_singleton_queue ON ${schema}.job (name, singletonKey) WHERE state < '${states.active}' AND singletonOn IS NULL AND singletonKey LIKE '${SINGLETON_QUEUE_KEY_ESCAPED}%'
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

function createIndexJobFetch (schema) {
  return `
    CREATE INDEX job_fetch ON ${schema}.job (name text_pattern_ops, startAfter) WHERE state < '${states.active}'
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

function createSubscriptionTable (schema) {
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
  return (includeMetadata, enforceSingletonQueueActiveLimit) => `
    WITH nextJob as (
      SELECT id
      FROM ${schema}.job j
      WHERE state < '${states.active}'
        AND name LIKE $1
        AND startAfter < now()
        ${enforceSingletonQueueActiveLimit
        ? `AND (
          CASE
            WHEN singletonKey IS NOT NULL
              AND singletonKey LIKE '${SINGLETON_QUEUE_KEY_ESCAPED}%'
              THEN NOT EXISTS (
                SELECT 1
                FROM ${schema}.job active_job
                WHERE active_job.state = '${states.active}'
                  AND active_job.name = j.name
                  AND active_job.singletonKey = j.singletonKey
                  LIMIT 1
              )
            ELSE
              true
          END
        )`
        : ''}
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
    RETURNING ${includeMetadata ? 'j.*' : 'j.id, name, data'}, EXTRACT(epoch FROM expireIn) as expire_in_seconds
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

function cancelDuplicateJobs (schema) {
  return `
    UPDATE ${schema}.job
      SET state = '${states.cancelled}'
    WHERE
      id IN(
        SELECT
          job.id FROM pgboss.job job
        LEFT JOIN pgboss.job existing ON existing.id <> job.id
          AND job.singletonkey = existing.singletonkey
          AND existing.state = '${states.created}'
      WHERE
        job.state = '${states.active}'
        AND(job.startedOn + job.expireIn) < now()
        AND existing.id IS NOT NULL
      GROUP BY
        job.id)
  `
}

function completeJobs (schema) {
  return `
    WITH results AS (
      UPDATE ${schema}.job
      SET completedOn = now(),
        state = '${states.completed}',
        output = $2::jsonb
      WHERE id IN (SELECT UNNEST($1::uuid[]))
        AND state = '${states.active}'
      RETURNING *
    ), completion_jobs as (
      INSERT INTO ${schema}.job (name, data, keepUntil)
      SELECT
        '${COMPLETION_JOB_PREFIX}' || name,
        ${buildJsonCompletionObject(true)},
        ${keepUntilInheritance}
      FROM results
      WHERE NOT name LIKE '${COMPLETION_JOB_PREFIX}%'
        AND on_complete
    )
    SELECT COUNT(*) FROM results
  `
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
        startAfter = ${retryStartAfterCase},
        output = $2::jsonb
      WHERE id IN (SELECT UNNEST($1::uuid[]))
        AND state < '${states.completed}'
      RETURNING *
    ), completion_jobs as (
      INSERT INTO ${schema}.job (name, data, keepUntil)
      SELECT
        '${COMPLETION_JOB_PREFIX}' || name,
        ${buildJsonCompletionObject(true)},
        ${keepUntilInheritance}
      FROM results
      WHERE state = '${states.failed}'
        AND NOT name LIKE '${COMPLETION_JOB_PREFIX}%'
        AND on_complete
    )
    SELECT COUNT(*) FROM results
  `
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
      '${COMPLETION_JOB_PREFIX}' || name,
      ${buildJsonCompletionObject()},
      ${keepUntilInheritance}
    FROM results
    WHERE state = '${states.expired}'
      AND NOT name LIKE '${COMPLETION_JOB_PREFIX}%'
      AND on_complete
  `
}

function cancelJobs (schema) {
  return `
    with results as (
      UPDATE ${schema}.job
      SET completedOn = now(),
        state = '${states.cancelled}'
      WHERE id IN (SELECT UNNEST($1::uuid[]))
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
      WHERE id IN (SELECT UNNEST($1::uuid[]))
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
      keepUntil,
      on_complete
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
      keepUntil,
      on_complete
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
            $13::text as keepUntilValue,
            $14::boolean as on_complete
        ) j1
      ) j2
    ) j3
    ON CONFLICT DO NOTHING
    RETURNING id
  `
}

function insertJobs (schema) {
  return `
    INSERT INTO ${schema}.job (
      id,
      name,
      data,
      priority,
      startAfter,
      expireIn,
      retryLimit,
      retryDelay,
      retryBackoff,
      singletonKey,
      keepUntil,
      on_complete
    )
    SELECT
      COALESCE(id, gen_random_uuid()) as id,
      name,
      data,
      COALESCE(priority, 0) as priority,
      COALESCE("startAfter", now()) as startAfter,
      COALESCE("expireInSeconds", 15 * 60) * interval '1s' as expireIn,
      COALESCE("retryLimit", 0) as retryLimit,
      COALESCE("retryDelay", 0) as retryDelay,
      COALESCE("retryBackoff", false) as retryBackoff,
      "singletonKey",
      COALESCE("keepUntil", now() + interval '14 days') as keepUntil,
      COALESCE("onComplete", false) as onComplete
    FROM json_to_recordset($1) as x(
      id uuid,
      name text,
      priority integer,
      data jsonb,
      "retryLimit" integer,
      "retryDelay" integer,
      "retryBackoff" boolean,
      "startAfter" timestamp with time zone,
      "singletonKey" text,
      "expireInSeconds" integer,
      "keepUntil" timestamp with time zone,
      "onComplete" boolean
    )
    ON CONFLICT DO NOTHING
  `
}

function purge (schema, interval) {
  return `
    DELETE FROM ${schema}.archive
    WHERE archivedOn < (now() - interval '${interval}')
  `
}

function archive (schema, completedInterval, failedInterval = completedInterval) {
  return `
    WITH archived_rows AS (
      DELETE FROM ${schema}.job
      WHERE (
          state <> '${states.failed}' AND completedOn < (now() - interval '${completedInterval}')
        )
        OR (
          state = '${states.failed}' AND completedOn < (now() - interval '${failedInterval}')
        )
        OR (
          state < '${states.active}' AND keepUntil < now()
        )
      RETURNING *
    )
    INSERT INTO ${schema}.archive (
      id, name, priority, data, state, retryLimit, retryCount, retryDelay, retryBackoff, startAfter, startedOn, singletonKey, singletonOn, expireIn, createdOn, completedOn, keepUntil, on_complete, output
    )
    SELECT
      id, name, priority, data, state, retryLimit, retryCount, retryDelay, retryBackoff, startAfter, startedOn, singletonKey, singletonOn, expireIn, createdOn, completedOn, keepUntil, on_complete, output
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

function advisoryLock (schema) {
  return `SELECT pg_advisory_xact_lock(
      ('x' || md5(current_database() || '.pgboss.${schema}'))::bit(64)::bigint
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
  return `SELECT * From ${schema}.${table} WHERE id = $1`
}
