const DEFAULT_SCHEMA = 'pgboss'
const MIGRATE_RACE_MESSAGE = 'division by zero'
const CREATE_RACE_MESSAGE = 'already exists'

const JOB_STATES = Object.freeze({
  created: 'created',
  retry: 'retry',
  active: 'active',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed'
})

const QUEUE_POLICIES = Object.freeze({
  standard: 'standard',
  short: 'short',
  singleton: 'singleton',
  stately: 'stately'
})

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
  deleteJobsById,
  dropAllJobs,
  dropQueuedJobs,
  dropStoredJobs,
  failJobsById,
  failJobsByTimeout,
  insertJobs,
  getTime,
  getSchedules,
  schedule,
  unschedule,
  subscribe,
  unsubscribe,
  getQueuesForEvent,
  deletion,
  cacheQueueStats,
  updateQueue,
  createQueue,
  deleteQueue,
  getQueues,
  getQueueSize,
  trySetQueueMonitorTime,
  trySetQueueDeletionTime,
  trySetMaintenanceTime,
  trySetCronTime,
  locked,
  assertMigration,
  getJobById,
  QUEUE_POLICIES,
  JOB_STATES,
  MIGRATE_RACE_MESSAGE,
  CREATE_RACE_MESSAGE,
  DEFAULT_SCHEMA
}

const assert = require('node:assert')

function create (schema, version) {
  const commands = [
    createSchema(schema),
    createEnumJobState(schema),

    createTableVersion(schema),
    createTableQueue(schema),
    createTableSchedule(schema),
    createTableSubscription(schema),

    createTableJob(schema),
    createPrimaryKeyJob(schema),
    createTableJobCommon(schema),

    createQueueFunction(schema),
    deleteQueueFunction(schema),

    insertVersion(schema, version)
  ]

  return locked(schema, commands)
}

function createSchema (schema) {
  return `CREATE SCHEMA IF NOT EXISTS ${schema}`
}

function createEnumJobState (schema) {
  // ENUM definition order is important
  // base type is numeric and first values are less than last values
  return `
    CREATE TYPE ${schema}.job_state AS ENUM (
      '${JOB_STATES.created}',
      '${JOB_STATES.retry}',
      '${JOB_STATES.active}',
      '${JOB_STATES.completed}',
      '${JOB_STATES.cancelled}',
      '${JOB_STATES.failed}'
    )
  `
}

function createTableVersion (schema) {
  return `
    CREATE TABLE ${schema}.version (
      version int primary key,
      maintained_on timestamp with time zone,
      monitored_on timestamp with time zone,
      cron_on timestamp with time zone
    )
  `
}

function createTableQueue (schema) {
  return `
    CREATE TABLE ${schema}.queue (
      name text,
      policy text,
      retry_limit int,
      retry_delay int,
      retry_backoff bool,
      expire_seconds int,
      retention_seconds int,
      deletion_seconds int,
      dead_letter text REFERENCES ${schema}.queue (name),
      table_name text,
      available_count int,
      active_count int,
      total_count int,
      monitor_on timestamp with time zone,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name)
    )
  `
}

function createTableSchedule (schema) {
  return `
    CREATE TABLE ${schema}.schedule (
      name text REFERENCES ${schema}.queue ON DELETE CASCADE,
      cron text not null,
      timezone text,
      data jsonb,
      options jsonb,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name)
    )
  `
}

function createTableSubscription (schema) {
  return `
    CREATE TABLE ${schema}.subscription (
      event text not null,
      name text not null REFERENCES ${schema}.queue ON DELETE CASCADE,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY(event, name)
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
      state ${schema}.job_state not null default('${JOB_STATES.created}'),
      retry_limit integer not null default(2),
      retry_count integer not null default(0),
      retry_delay integer not null default(0),
      retry_backoff boolean not null default false,
      start_after timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      singleton_key text,
      singleton_on timestamp without time zone,
      expire_in interval not null default interval '15 minutes',
      created_on timestamp with time zone not null default now(),
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '14 days',
      output jsonb,
      policy text      
    ) PARTITION BY LIST (name)
  `
}

const JOB_COLUMNS_MIN = 'id, name, data, EXTRACT(epoch FROM expire_in) as "expireInSeconds"'
const JOB_COLUMNS_ALL = `${JOB_COLUMNS_MIN},
  policy,
  state,
  priority,
  retry_limit as "retryLimit",
  retry_count as "retryCount",
  retry_delay as "retryDelay",
  retry_backoff as "retryBackoff",
  start_after as "startAfter",  
  started_on as "startedOn",
  singleton_key as "singletonKey",
  singleton_on as "singletonOn",
  expire_in as "expireIn",
  created_on as "createdOn",
  completed_on as "completedOn",
  keep_until as "keepUntil",
  output
`

function createTableJobCommon (schema) {
  const table = 'job_common'
  const format = command => command.replaceAll('.job', `.${table}`) + ';'

  return `
    CREATE TABLE ${schema}.${table} (LIKE ${schema}.job INCLUDING DEFAULTS);
    ${format(createPrimaryKeyJob(schema))}
    ${format(createQueueForeignKeyJob(schema))}
    ${format(createIndexJobPolicyShort(schema))}
    ${format(createIndexJobPolicySingleton(schema))}
    ${format(createIndexJobPolicyStately(schema))}
    ${format(createIndexJobThrottle(schema))}
    ${format(createIndexJobFetch(schema))}
    ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.${table} DEFAULT;
  `
}

function createQueueFunction (schema) {
  return `
    CREATE FUNCTION ${schema}.create_queue(queue_name text, options json)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job'
                            END;
      queue_created_on timestamptz;
    BEGIN

      WITH q as (
        INSERT INTO ${schema}.queue (
          name,
          policy,
          retry_limit,
          retry_delay,
          retry_backoff,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          dead_letter,
          table_name
        )
        VALUES (
          queue_name,
          options->>'policy',
          (options->>'retryLimit')::int,
          (options->>'retryDelay')::int,
          (options->>'retryBackoff')::bool,
          (options->>'expireInSeconds')::int,
          (options->>'retentionSeconds')::int,
          (options->>'deletionSeconds')::bool,
          options->>'deadLetter',
          tablename
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR tablename = 'job' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE ${schema}.%I (LIKE ${schema}.job INCLUDING DEFAULTS)', tablename);
      
      EXECUTE format('${formatPartitionCommand(createPrimaryKeyJob(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createQueueForeignKeyJob(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobPolicyShort(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobPolicySingleton(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobPolicyStately(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobThrottle(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobFetch(schema))}', tablename);

      EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `
}

function formatPartitionCommand (command) {
  return command
    .replace('.job', '.%1$I')
    .replace('job_i', '%1$s_i')
    .replaceAll("'", "''")
}

function deleteQueueFunction (schema) {
  return `
    CREATE FUNCTION ${schema}.delete_queue(queue_name text)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar;
    BEGIN
      SELECT table_name FROM ${schema}.queue WHERE name = queue_name INTO tablename;

      IF tablename = 'job' THEN
        DELETE FROM ${schema}.job WHERE name = queue_name;
      ELSE
        EXECUTE format('DROP TABLE IF EXISTS ${schema}.%I', tablename);
      END IF;

      DELETE FROM ${schema}.queue WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  `
}

function createQueue (schema) {
  return `SELECT ${schema}.create_queue($1, $2)`
}

function deleteQueue (schema) {
  return `SELECT ${schema}.delete_queue($1)`
}

function createPrimaryKeyJob (schema) {
  return `ALTER TABLE ${schema}.job ADD PRIMARY KEY (name, id)`
}

function createQueueForeignKeyJob (schema) {
  return `ALTER TABLE ${schema}.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`
}

function createIndexJobPolicyShort (schema) {
  return `CREATE UNIQUE INDEX job_i1 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = '${JOB_STATES.created}' AND policy = '${QUEUE_POLICIES.short}';`
}

function createIndexJobPolicySingleton (schema) {
  return `CREATE UNIQUE INDEX job_i2 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = '${JOB_STATES.active}' AND policy = '${QUEUE_POLICIES.singleton}'`
}

function createIndexJobPolicyStately (schema) {
  return `CREATE UNIQUE INDEX job_i3 ON ${schema}.job (name, state, COALESCE(singleton_key, '')) WHERE state <= '${JOB_STATES.active}' AND policy = '${QUEUE_POLICIES.stately}'`
}

function createIndexJobThrottle (schema) {
  return `CREATE UNIQUE INDEX job_i4 ON ${schema}.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> '${JOB_STATES.cancelled}' AND singleton_on IS NOT NULL`
}

function createIndexJobFetch (schema) {
  return `CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < '${JOB_STATES.active}'`
}

function trySetQueueMonitorTime (schema, queueName, seconds) {
  return trySetQueueTimestamp(schema, queueName, 'monitor_on', seconds)
}

function trySetQueueDeletionTime (schema, queueName, seconds) {
  return trySetQueueTimestamp(schema, queueName, 'archive_on', seconds)
}

function trySetMaintenanceTime (schema, seconds) {
  return trySetTimestamp(schema, 'maintained_on', seconds)
}

function trySetCronTime (schema, seconds) {
  return trySetTimestamp(schema, 'cron_on', seconds)
}

function trySetTimestamp (schema, column, seconds) {
  return `
    UPDATE ${schema}.version
    SET ${column} = now()
    WHERE EXTRACT( EPOCH FROM (now() - COALESCE(${column}, now() - interval '1 week') ) ) > ${seconds}
    RETURNING true
  `
}

function trySetQueueTimestamp (schema, queueName, column, seconds) {
  return `
    UPDATE ${schema}.queue
    SET ${column} = now()
    WHERE name = '${queueName}'
      AND EXTRACT( EPOCH FROM (now() - COALESCE(${column}, now() - interval '1 week') ) ) > ${seconds}
    RETURNING true
  `
}

function updateQueue (schema, { deadLetter } = {}) {
  return `
    UPDATE ${schema}.queue SET
      policy = COALESCE($2, policy),
      retry_limit = COALESCE($3, retry_limit),
      retry_delay = COALESCE($4, retry_delay),
      retry_backoff = COALESCE($5, retry_backoff),
      expire_seconds = COALESCE($6, expire_seconds),
      retention_seconds = COALESCE($7, retention_seconds),
      ${
        deadLetter === undefined
          ? ''
          : 'dead_letter = CASE WHEN $8 IS DISTINCT FROM dead_letter THEN $8 ELSE dead_letter END,'
      }
      updated_on = now()
    WHERE name = $1
  `
}

function getQueues (schema, names) {
  return `
    SELECT 
      q.name,
      q.policy,
      q.retry_limit as "retryLimit",
      q.retry_delay as "retryDelay",
      q.retry_backoff as "retryBackoff",
      q.expire_seconds as "expireInSeconds",
      q.retention_seconds as "retentionSeconds",
      q.dead_letter as "deadLetter",
      dlq.table_name as "deadLetterTable",
      q.archive,
      q.queued_count as "queuedCount",
      q.active_count as "activeCount",
      q.total_count as "totalCount",
      q.table_name as "table",
      q.created_on as "createdOn",
      q.updated_on as "updatedOn"
    FROM ${schema}.queue q
      LEFT JOIN ${schema}.queue dlq ON q.dead_letter = dlq.name
    ${names ? `WHERE q.name IN (${names.map(i => `'${i}'`)})` : ''}
   `
}

function deleteJobsById (schema, table) {
  return `
    WITH results as (
      DELETE FROM ${schema}.${table}
      WHERE name = $1
        AND id IN (SELECT UNNEST($2::uuid[]))        
      RETURNING 1
    )
    SELECT COUNT(*) from results
  `
}

function dropQueuedJobs (schema, table) {
  return `DELETE from ${schema}.${table} WHERE name = $1 and state < '${JOB_STATES.active}'`
}

function dropStoredJobs (schema, table) {
  return `DELETE from ${schema}.${table} WHERE name = $1 and state > '${JOB_STATES.active}'`
}

function dropAllJobs (schema, table) {
  return table === 'job'
    ? `DELETE from ${schema}.${table} WHERE name = $1`
    : `TRUNCATE ${schema}.${table}`
}

function getQueueSize (schema, table, before = JOB_STATES.active) {
  assert(before in JOB_STATES, `${before} is not a valid state`)
  return `SELECT count(*) as count FROM ${schema}.${table} WHERE name = $1 AND state < '${before}'`
}

function getSchedules (schema) {
  return `SELECT * FROM ${schema}.schedule`
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

function fetchNextJob ({ schema, table, name, limit, includeMetadata, priority = true }) {
  return `
    WITH next as (
      SELECT id
      FROM ${schema}.${table}
      WHERE name = '${name}'
        AND state < '${JOB_STATES.active}'
        AND start_after < now()
      ORDER BY ${priority ? 'priority desc, ' : ''}created_on, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${schema}.${table} j SET
      state = '${JOB_STATES.active}',
      started_on = now(),
      retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
    FROM next
    WHERE name = '${name}' AND j.id = next.id
    RETURNING j.${includeMetadata ? JOB_COLUMNS_ALL : JOB_COLUMNS_MIN}      
  `
}

function completeJobs (schema, table) {
  return `
    WITH results AS (
      UPDATE ${schema}.${table}
      SET completed_on = now(),
        state = '${JOB_STATES.completed}',
        output = $3::jsonb
      WHERE name = $1
        AND id IN (SELECT UNNEST($2::uuid[]))
        AND state = '${JOB_STATES.active}'
      RETURNING *
    )
    SELECT COUNT(*) FROM results
  `
}

function cancelJobs (schema, table) {
  return `
    WITH results as (
      UPDATE ${schema}.${table}
      SET completed_on = now(),
        state = '${JOB_STATES.cancelled}'
      WHERE name = $1
        AND id IN (SELECT UNNEST($2::uuid[]))
        AND state < '${JOB_STATES.completed}'
      RETURNING 1
    )
    SELECT COUNT(*) from results
  `
}

function resumeJobs (schema, table) {
  return `
    WITH results as (
      UPDATE ${schema}.${table}
      SET completed_on = NULL,
        state = '${JOB_STATES.created}'
      WHERE name = $1
        AND id IN (SELECT UNNEST($2::uuid[]))
        AND state = '${JOB_STATES.cancelled}'
      RETURNING 1
    )
    SELECT COUNT(*) from results
  `
}

function insertJobs (schema, { table, queueName, returnId = true }) {
  const sql = `
    INSERT INTO ${schema}.${table} (
      id,
      name,
      data,
      priority,
      start_after,
      singleton_key,
      singleton_on,
      expire_in,
      keep_until,
      retry_limit,
      retry_delay,
      retry_backoff,
      policy
    )
    SELECT
      COALESCE(id, gen_random_uuid()) as id,
      '${queueName}' as name,
      data,
      COALESCE(priority, 0) as priority,
      j.start_after,
      "singletonKey" as singleton_key,
      CASE
        WHEN "singletonSeconds" IS NOT NULL THEN 'epoch'::timestamp + '1 second'::interval * ("singletonSeconds" * floor(( date_part('epoch', now()) + "singletonOffset") / "singletonSeconds" ))
        ELSE NULL
        END as singleton_on,
      CASE
        WHEN "expireInSeconds" IS NOT NULL THEN "expireInSeconds" *  interval '1s'
        WHEN q.expire_seconds IS NOT NULL THEN q.expire_seconds * interval '1s'
        ELSE interval '15 minutes'
        END as expire_in,
      CASE
        WHEN "keepUntil" IS NOT NULL THEN "keepUntil"
        ELSE COALESCE(j.start_after, now()) + CAST(COALESCE((q.retention_seconds * 60)::text, '14 days') as interval)
        END as keep_until,
      COALESCE("retryLimit", q.retry_limit, 2),
      CASE
        WHEN COALESCE("retryBackoff", q.retry_backoff, false)
          THEN GREATEST(COALESCE("retryDelay", q.retry_delay), 1)
        ELSE COALESCE("retryDelay", q.retry_delay, 0)
        END as retry_delay,      
      COALESCE("retryBackoff", q.retry_backoff, false) as retry_backoff,
      q.policy
    FROM (
      SELECT *,
        CASE
          WHEN right("startAfter", 1) = 'Z' THEN CAST("startAfter" as timestamp with time zone)
          ELSE now() + CAST(COALESCE("startAfter",'0') as interval)
          END as start_after
      FROM json_to_recordset($1) as x (
        id uuid,
        name text,
        priority integer,
        data jsonb,
        "startAfter" text,
        "retryLimit" integer,
        "retryDelay" integer,
        "retryBackoff" boolean,
        "singletonKey" text,
        "singletonSeconds" integer,
        "singletonOffset" integer,
        "expireInSeconds" integer,
        "keepUntil" timestamp with time zone
      ) 
    ) j
    JOIN ${schema}.queue q ON q.name = '${queueName}'
    ON CONFLICT DO NOTHING
    ${returnId ? 'RETURNING id' : ''}
  `

  return sql
}

function failJobs (schema, queue, where, output) {
  const { table, deadLetter, deadLetterTable } = queue

  let dlqSql = ''

  if (deadLetter && deadLetterTable) {
    dlqSql = `, dlq_jobs as (
      INSERT INTO ${schema}.${deadLetterTable} (name, data, output, retry_limit, keep_until)
      SELECT
        '${deadLetter}',
        data,
        output,
        retry_limit,
        keep_until + (keep_until - start_after)
      FROM results
      WHERE state = '${JOB_STATES.failed}'
    )`
  }

  return `
    WITH results AS (
      UPDATE ${schema}.${table} SET
        state = CASE
          WHEN retry_count < retry_limit THEN '${JOB_STATES.retry}'::${schema}.job_state
          ELSE '${JOB_STATES.failed}'::${schema}.job_state
          END,
        completed_on = CASE
          WHEN retry_count < retry_limit THEN NULL
          ELSE now()
          END,
        start_after = CASE
          WHEN retry_count = retry_limit THEN start_after
          WHEN NOT retry_backoff THEN now() + retry_delay * interval '1'
          ELSE now() + (
                retry_delay * 2 ^ LEAST(16, retry_count + 1) / 2 +
                retry_delay * 2 ^ LEAST(16, retry_count + 1) / 2 * random()
            ) * interval '1'
          END,
        output = ${output}
      WHERE ${where}
      RETURNING *
    ) ${dlqSql}
    SELECT COUNT(*) FROM results
  `
}

function failJobsById (schema, queue) {
  const where = `name = $1 AND id IN (SELECT UNNEST($2::uuid[])) AND state < '${JOB_STATES.completed}'`
  const output = '$3::jsonb'

  return failJobs(schema, queue, where, output)
}

function failJobsByTimeout (schema, queue) {
  const where = `state = '${JOB_STATES.active}' AND (started_on + expire_in) < now()`
  const output = '\'{ "value": { "message": "job timed out" } }\'::jsonb'

  return locked(schema, failJobs(schema, queue, where, output), queue.name + 'failJobsByTimeout')
}

function deletion (schema, table, completedInterval) {
  const sql = `
      DELETE FROM ${schema}.${table}
      WHERE (completed_on < (now() - interval '${completedInterval}'))
        OR (state < '${JOB_STATES.active}' AND keep_until < now())
  `

  return locked(schema, sql, table + 'deletion')
}

function cacheQueueStats (schema, queue) {
  const { name, table } = queue

  const sql = `
    WITH stats AS (
      SELECT
        count(*) FILTER (WHERE state < '${JOB_STATES.active}') as available_count,
        count(*) FILTER (WHERE state = '${JOB_STATES.active}') as active_count,
        count(*) as total_count
      FROM ${schema}.${table}
    )
    UPDATE ${schema}.queue SET
      available_count = stats.available_count,
      active_count = stats.active_count,
      total_count = stats.total_count
    FROM stats
      WHERE queue.name = '${name}'
  `

  return locked(schema, sql, queue + 'stats')
}

function locked (schema, query, key) {
  if (Array.isArray(query)) {
    query = query.join(';\n')
  }

  return `
    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    ${advisoryLock(schema, key)};
    ${query};
    COMMIT;
  `
}

function advisoryLock (schema, key) {
  return `SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.${schema}${key || ''}')::bytea), 'hex'))::bit(64)::bigint
  )`
}

function assertMigration (schema, version) {
  // raises 'division by zero' if already on desired schema version
  return `SELECT version::int/(version::int-${version}) from ${schema}.version`
}

function getJobById (schema, table) {
  return `SELECT ${JOB_COLUMNS_ALL} FROM ${schema}.${table} WHERE name = $1 AND id = $2`
}
