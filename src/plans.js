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
  deleteJobs,
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
  cacheQueueStats,
  updateQueue,
  createQueue,
  deleteQueue,
  getQueues,
  getQueueByName,
  getQueueSize,
  purgeQueue,
  trySetQueueMonitorTime,
  trySetQueueArchiveTime,
  trySetMaintenanceTime,
  trySetCronTime,
  locked,
  assertMigration,
  getJobById,
  getArchivedJobById,
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

    createTableArchive(schema),
    createPrimaryKeyArchive(schema),
    createColumnArchiveArchivedOn(schema),
    createIndexArchiveArchivedOn(schema),

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
      retention_minutes int,
      dead_letter text REFERENCES ${schema}.queue (name),
      table_name text,
      available_count int,
      active_count int,
      total_count int,
      archive bool not null default(true),
      archive_on timestamp with time zone,
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
      dead_letter text,
      policy text      
    ) PARTITION BY LIST (name)
  `
}

const baseJobColumns =
  'id, name, data, EXTRACT(epoch FROM expire_in) as "expireInSeconds"'
const allJobColumns = `${baseJobColumns},
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
  dead_letter as "deadLetter",
  output
`

function createQueueFunction (schema) {
  return `
    CREATE FUNCTION ${schema}.create_queue(queue_name text, options json)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := 'j' || encode(sha224(queue_name::bytea), 'hex');
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
        retention_minutes,
        archive,
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
        (options->>'retentionMinutes')::int,
        (options->>'archive')::bool,
        options->>'deadLetter',
        tablename
      )
      ON CONFLICT DO NOTHING
      RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE ${schema}.%I (LIKE ${schema}.job INCLUDING DEFAULTS)', tablename);
      
      EXECUTE format('${formatPartitionCommand(createPrimaryKeyJob(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createQueueForeignKeyJob(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createQueueForeignKeyJobDeadLetter(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobPolicyShort(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobPolicySingleton(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobPolicyStately(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobThrottle(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobFetch(schema))}', tablename);

      EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      --EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);
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
      WITH deleted as (
        DELETE FROM ${schema}.queue
        WHERE name = queue_name
        RETURNING table_name
      )
      SELECT table_name from deleted INTO tablename;

      EXECUTE format('DROP TABLE IF EXISTS ${schema}.%I', tablename);
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

function createQueueForeignKeyJobDeadLetter (schema) {
  return `ALTER TABLE ${schema}.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`
}

function createPrimaryKeyArchive (schema) {
  return `ALTER TABLE ${schema}.archive ADD PRIMARY KEY (name, id)`
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

function createTableArchive (schema) {
  return `CREATE TABLE ${schema}.archive (LIKE ${schema}.job)`
}

function createColumnArchiveArchivedOn (schema) {
  return `ALTER TABLE ${schema}.archive ADD archived_on timestamptz NOT NULL DEFAULT now()`
}

function createIndexArchiveArchivedOn (schema) {
  return `CREATE INDEX archive_i1 ON ${schema}.archive(archived_on)`
}

function trySetQueueMonitorTime (schema, queue, seconds) {
  return trySetQueueTimestamp(schema, queue, 'monitor_on', seconds)
}

function trySetQueueArchiveTime (schema, queue, seconds) {
  return trySetQueueTimestamp(schema, queue, 'archive_on', seconds)
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

function trySetQueueTimestamp (schema, queue, column, seconds) {
  return `
    UPDATE ${schema}.queue
    SET ${column} = now()
    WHERE name = '${queue}'
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
      retention_minutes = COALESCE($7, retention_minutes),
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
      name,
      policy,
      retry_limit as "retryLimit",
      retry_delay as "retryDelay",
      retry_backoff as "retryBackoff",
      expire_seconds as "expireInSeconds",
      retention_minutes as "retentionMinutes",
      dead_letter as "deadLetter",
      archive,
      available_count as "availableCount",
      active_count as "activeCount",
      total_count as "totalCount",
      table_name as "table",
      created_on as "createdOn",
      updated_on as "updatedOn"
    FROM ${schema}.queue
    ${names ? `WHERE name IN (${names.map(i => `'${i}'`)})` : ''}
   `
}

function getQueueByName (schema) {
  return `${getQueues(schema)} WHERE name = $1`
}

function purgeQueue (schema, table) {
  return `DELETE from ${schema}.${table} WHERE name = $1 and state < '${JOB_STATES.active}'`
}

// todo: convert to function
// function clearStorage (schema) {
//   return `TRUNCATE ${schema}.job, ${schema}.archive`
// }

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

function fetchNextJob ({
  schema,
  table,
  name,
  limit,
  includeMetadata,
  priority = true
}) {
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
    RETURNING j.${includeMetadata ? allJobColumns : baseJobColumns}      
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

function deleteJobs (schema, table) {
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

function insertJob (schema, table) {
  return `
    INSERT INTO ${schema}.${table} (
      id,
      name,
      data,
      priority,
      start_after,
      singleton_key,
      singleton_on,
      dead_letter,
      expire_in,
      keep_until,
      retry_limit,
      retry_delay,
      retry_backoff,
      policy
    )
    SELECT
      id,
      j.name,
      data,
      priority,
      start_after,
      singleton_key,
      singleton_on,
      COALESCE(j.dead_letter, q.dead_letter) as dead_letter,
      CASE
        WHEN expire_in IS NOT NULL THEN CAST(expire_in as interval)
        WHEN q.expire_seconds IS NOT NULL THEN q.expire_seconds * interval '1s'
        WHEN expire_in_default IS NOT NULL THEN CAST(expire_in_default as interval)
        ELSE interval '15 minutes'
        END as expire_in,
      CASE
        WHEN right(keep_until, 1) = 'Z' THEN CAST(keep_until as timestamp with time zone)
        ELSE start_after + CAST(COALESCE(keep_until, (q.retention_minutes * 60)::text, keep_until_default, '14 days') as interval)
        END as keep_until,
      COALESCE(j.retry_limit, q.retry_limit, retry_limit_default, 2) as retry_limit,
      CASE
        WHEN COALESCE(j.retry_backoff, q.retry_backoff, retry_backoff_default, false)
        THEN GREATEST(COALESCE(j.retry_delay, q.retry_delay, retry_delay_default), 1)
        ELSE COALESCE(j.retry_delay, q.retry_delay, retry_delay_default, 0)
        END as retry_delay,
      COALESCE(j.retry_backoff, q.retry_backoff, retry_backoff_default, false) as retry_backoff,
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
            END as start_after,
          $6 as singleton_key,
          CASE
            WHEN $7::integer IS NOT NULL THEN 'epoch'::timestamp + '1 second'::interval * ($7 * floor((date_part('epoch', now()) + $8) / $7))
            ELSE NULL
            END as singleton_on,
          $9 as dead_letter,
          $10 as expire_in,
          $11 as expire_in_default,
          $12 as keep_until,
          $13 as keep_until_default,
          $14::int as retry_limit,
          $15::int as retry_limit_default,
          $16::int as retry_delay,
          $17::int as retry_delay_default,
          $18::bool as retry_backoff,
          $19::bool as retry_backoff_default
      ) j JOIN ${schema}.queue q ON j.name = q.name
    ON CONFLICT DO NOTHING
    RETURNING id
  `
}

function insertJobs (schema, table, queue) {
  return `
    WITH defaults as (
      SELECT 
        $2 as expire_in,
        $3 as keep_until,
        $4::int as retry_limit,
        $5::int as retry_delay,
        $6::bool as retry_backoff
    )
    INSERT INTO ${schema}.${table} (
      id,
      name,
      data,
      priority,
      start_after,
      singleton_key,
      singleton_on,
      dead_letter,
      expire_in,
      keep_until,
      retry_limit,
      retry_delay,
      retry_backoff,
      policy
    )
    SELECT
      COALESCE(id, gen_random_uuid()) as id,
      '${queue}' as name,
      data,
      COALESCE(priority, 0) as priority,
      j.start_after,
      "singletonKey" as singleton_key,
      CASE
        WHEN "singletonSeconds" IS NOT NULL THEN 'epoch'::timestamp + '1 second'::interval * ("singletonSeconds" * floor( date_part('epoch', now()) / "singletonSeconds" ))
        ELSE NULL
        END as singleton_on,
      COALESCE("deadLetter", q.dead_letter) as dead_letter,
      CASE
        WHEN "expireInSeconds" IS NOT NULL THEN "expireInSeconds" *  interval '1s'
        WHEN q.expire_seconds IS NOT NULL THEN q.expire_seconds * interval '1s'
        WHEN defaults.expire_in IS NOT NULL THEN CAST(defaults.expire_in as interval)
        ELSE interval '15 minutes'
        END as expire_in,
      CASE
        WHEN "keepUntil" IS NOT NULL THEN "keepUntil"
        ELSE COALESCE(j.start_after, now()) + CAST(COALESCE((q.retention_minutes * 60)::text, defaults.keep_until, '14 days') as interval)
        END as keep_until,
      COALESCE("retryLimit", q.retry_limit, defaults.retry_limit, 2),
      CASE
        WHEN COALESCE("retryBackoff", q.retry_backoff, defaults.retry_backoff, false)
          THEN GREATEST(COALESCE("retryDelay", q.retry_delay, defaults.retry_delay), 1)
        ELSE COALESCE("retryDelay", q.retry_delay, defaults.retry_delay, 0)
        END as retry_delay,      
      COALESCE("retryBackoff", q.retry_backoff, defaults.retry_backoff, false) as retry_backoff,
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
        "expireInSeconds" integer,
        "keepUntil" timestamp with time zone,
        "deadLetter" text
      ) 
    ) j
    JOIN ${schema}.queue q ON q.name = '${queue}',
      defaults
    ON CONFLICT DO NOTHING
  `
}

function failJobs (schema, table, where, output) {
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
    ), dlq_jobs as (
      INSERT INTO ${schema}.job (name, data, output, retry_limit, keep_until)
      SELECT
        dead_letter,
        data,
        output,
        retry_limit,
        keep_until + (keep_until - start_after)
      FROM results
      WHERE state = '${JOB_STATES.failed}'
        AND dead_letter IS NOT NULL
        AND NOT name = dead_letter
    )
    SELECT COUNT(*) FROM results
  `
}

function failJobsById (schema, table) {
  const where = `name = $1 AND id IN (SELECT UNNEST($2::uuid[])) AND state < '${JOB_STATES.completed}'`
  const output = '$3::jsonb'

  return failJobs(schema, table, where, output)
}

function failJobsByTimeout (schema, table) {
  const where = `state = '${JOB_STATES.active}' AND (started_on + expire_in) < now()`
  const output = '\'{ "value": { "message": "job timed out" } }\'::jsonb'

  return locked(schema, failJobs(schema, table, where, output), table + 'failJobsByTimeout')
}

function archive (schema, table, archive, completedInterval, failedInterval = completedInterval) {
  const columns =
    'id, name, priority, data, state, retry_limit, retry_count, retry_delay, retry_backoff, start_after, started_on, singleton_key, singleton_on, expire_in, created_on, completed_on, keep_until, dead_letter, policy, output'

  let sql = `
      DELETE FROM ${schema}.${table}
      WHERE (state <> '${JOB_STATES.failed}' AND completed_on < (now() - interval '${completedInterval}'))
        OR (state = '${JOB_STATES.failed}' AND completed_on < (now() - interval '${failedInterval}'))
        OR (state < '${JOB_STATES.active}' AND keep_until < now())
  `

  if (archive) {
    sql = `
      WITH archived_rows AS (
        ${sql}  
        RETURNING *
      )
      INSERT INTO ${schema}.archive (${columns})
      SELECT ${columns}
      FROM archived_rows
      ON CONFLICT DO NOTHING
    `
  }

  return locked(schema, sql, table + 'archive')
}

function drop (schema, interval) {
  const sql = `DELETE FROM ${schema}.archive WHERE archived_on < (now() - interval '${interval}')`
  return locked(schema, sql)
}

function cacheQueueStats (schema, queue, table) {
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
      WHERE queue.name = '${queue}'
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

function getArchivedJobById (schema) {
  return getJobById(schema, 'archive')
}

function getJobById (schema, table) {
  return `SELECT ${allJobColumns} FROM ${schema}.${table} WHERE name = $1 AND id = $2`
}
