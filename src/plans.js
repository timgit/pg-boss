const DEFAULT_SCHEMA = 'pgboss'
const MIGRATE_RACE_MESSAGE = 'division by zero'
const CREATE_RACE_MESSAGE = 'already exists'
const FIFTEEN_MINUTES = 60 * 15
const FORTEEN_DAYS = 60 * 60 * 24 * 14
const SEVEN_DAYS = 60 * 60 * 24 * 7

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
  stately: 'stately',
  exclusive: 'exclusive'
})

const QUEUE_DEFAULTS = {
  expire_seconds: FIFTEEN_MINUTES,
  retention_seconds: FORTEEN_DAYS,
  deletion_seconds: SEVEN_DAYS,
  retry_limit: 2,
  retry_delay: 0,
  warning_queued: 0,
  retry_backoff: false,
  partition: false
}

const COMMON_JOB_TABLE = 'job_common'

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
  retryJobs,
  deleteJobsById,
  deleteAllJobs,
  deleteQueuedJobs,
  deleteStoredJobs,
  truncateTable,
  failJobsById,
  failJobsByTimeout,
  insertJobs,
  getTime,
  getSchedules,
  getSchedulesByQueue,
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
  getQueueStats,
  trySetQueueMonitorTime,
  trySetQueueDeletionTime,
  trySetCronTime,
  locked,
  assertMigration,
  getJobById,
  getJobsByData,
  QUEUE_POLICIES,
  JOB_STATES,
  MIGRATE_RACE_MESSAGE,
  CREATE_RACE_MESSAGE,
  DEFAULT_SCHEMA,
}

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
    createTableJobCommon(schema, COMMON_JOB_TABLE),

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
      cron_on timestamp with time zone
    )
  `
}

function createTableQueue (schema) {
  return `
    CREATE TABLE ${schema}.queue (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit int NOT NULL,
      retry_delay int NOT NULL,
      retry_backoff bool NOT NULL,
      retry_delay_max int,
      expire_seconds int NOT NULL,
      retention_seconds int NOT NULL,
      deletion_seconds int NOT NULL,
      dead_letter text REFERENCES ${schema}.queue (name) CHECK (dead_letter IS DISTINCT FROM name),
      partition bool NOT NULL,
      table_name text NOT NULL,
      deferred_count int NOT NULL default 0,
      queued_count int NOT NULL default 0,
      warning_queued int NOT NULL default 0,
      active_count int NOT NULL default 0,
      total_count int NOT NULL default 0,
      singletons_active text[],
      monitor_on timestamp with time zone,
      maintain_on timestamp with time zone,
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
      key text not null DEFAULT '',
      cron text not null,
      timezone text,
      data jsonb,
      options jsonb,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name, key)
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
      state ${schema}.job_state not null default '${JOB_STATES.created}',
      retry_limit integer not null default ${QUEUE_DEFAULTS.retry_limit},
      retry_count integer not null default 0,
      retry_delay integer not null default ${QUEUE_DEFAULTS.retry_delay},
      retry_backoff boolean not null default ${QUEUE_DEFAULTS.retry_backoff},
      retry_delay_max integer,
      expire_seconds int not null default ${QUEUE_DEFAULTS.expire_seconds},
      deletion_seconds int not null default ${QUEUE_DEFAULTS.deletion_seconds},
      singleton_key text,
      singleton_on timestamp without time zone,
      start_after timestamp with time zone not null default now(),
      created_on timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '${QUEUE_DEFAULTS.retention_seconds}',
      output jsonb,
      dead_letter text,
      policy text
    ) PARTITION BY LIST (name)
  `
}

const JOB_COLUMNS_MIN = 'id, name, data, expire_seconds as "expireInSeconds"'
const JOB_COLUMNS_ALL = `${JOB_COLUMNS_MIN},
  policy,
  state,
  priority,
  retry_limit as "retryLimit",
  retry_count as "retryCount",
  retry_delay as "retryDelay",
  retry_backoff as "retryBackoff",
  retry_delay_max as "retryDelayMax",
  start_after as "startAfter",
  started_on as "startedOn",
  singleton_key as "singletonKey",
  singleton_on as "singletonOn",
  deletion_seconds as "deleteAfterSeconds",
  created_on as "createdOn",
  completed_on as "completedOn",
  keep_until as "keepUntil",
  dead_letter as "deadLetter",
  output
`

function createTableJobCommon (schema, table) {
  const format = command => command.replaceAll('.job', `.${table}`) + ';'

  return `
    CREATE TABLE ${schema}.${table} (LIKE ${schema}.job INCLUDING GENERATED INCLUDING DEFAULTS);
    ${format(createPrimaryKeyJob(schema))}
    ${format(createQueueForeignKeyJob(schema))}
    ${format(createQueueForeignKeyJobDeadLetter(schema))}
    ${format(createIndexJobPolicyShort(schema))}
    ${format(createIndexJobPolicySingleton(schema))}
    ${format(createIndexJobPolicyStately(schema))}
    ${format(createIndexJobPolicyExclusive(schema))}
    ${format(createIndexJobThrottle(schema))}
    ${format(createIndexJobFetch(schema))}

    ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.${table} DEFAULT;
  `
}

function createQueueFunction (schema) {
  return `
    CREATE FUNCTION ${schema}.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE '${COMMON_JOB_TABLE}'
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
          retry_delay_max,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          warning_queued,
          dead_letter,
          partition,
          table_name
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, ${QUEUE_DEFAULTS.retry_limit}),
          COALESCE((options->>'retryDelay')::int, ${QUEUE_DEFAULTS.retry_delay}),
          COALESCE((options->>'retryBackoff')::bool, ${QUEUE_DEFAULTS.retry_backoff}),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, ${QUEUE_DEFAULTS.expire_seconds}),
          COALESCE((options->>'retentionSeconds')::int, ${QUEUE_DEFAULTS.retention_seconds}),
          COALESCE((options->>'deleteAfterSeconds')::int, ${QUEUE_DEFAULTS.deletion_seconds}),
          COALESCE((options->>'warningQueueSize')::int, ${QUEUE_DEFAULTS.warning_queued}),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, ${QUEUE_DEFAULTS.partition}),
          tablename
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE ${schema}.%I (LIKE ${schema}.job INCLUDING DEFAULTS)', tablename);
      
      EXECUTE format('${formatPartitionCommand(createPrimaryKeyJob(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createQueueForeignKeyJob(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createQueueForeignKeyJobDeadLetter(schema))}', tablename);

      EXECUTE format('${formatPartitionCommand(createIndexJobFetch(schema))}', tablename);
      EXECUTE format('${formatPartitionCommand(createIndexJobThrottle(schema))}', tablename);
      
      IF options->>'policy' = 'short' THEN
        EXECUTE format('${formatPartitionCommand(createIndexJobPolicyShort(schema))}', tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE format('${formatPartitionCommand(createIndexJobPolicySingleton(schema))}', tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE format('${formatPartitionCommand(createIndexJobPolicyStately(schema))}', tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE format('${formatPartitionCommand(createIndexJobPolicyExclusive(schema))}', tablename);
      END IF;

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
      v_table varchar;
      v_partition bool;
    BEGIN
      SELECT table_name, partition
      FROM ${schema}.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS ${schema}.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM ${schema}.%I WHERE name = %L', v_table, queue_name);
      END IF;

      DELETE FROM ${schema}.queue WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  `
}

function createQueue (schema, name, options) {
  const sql = `SELECT ${schema}.create_queue('${name}', '${JSON.stringify(options)}'::jsonb)`
  return locked(schema, sql, 'create-queue')
}

function deleteQueue (schema, name) {
  const sql = `SELECT ${schema}.delete_queue('${name}')`
  return locked(schema, sql, 'delete-queue')
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

function createIndexJobPolicyShort (schema) {
  return `CREATE UNIQUE INDEX job_i1 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = '${JOB_STATES.created}' AND policy = '${QUEUE_POLICIES.short}'`
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

function createIndexJobPolicyExclusive (schema) {
  return `CREATE UNIQUE INDEX job_i6 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state <= '${JOB_STATES.active}' AND policy = '${QUEUE_POLICIES.exclusive}'`
}

function trySetQueueMonitorTime (schema, queues, seconds) {
  return trySetQueueTimestamp(schema, queues, 'monitor_on', seconds)
}

function trySetQueueDeletionTime (schema, queues, seconds) {
  return trySetQueueTimestamp(schema, queues, 'maintain_on', seconds)
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

function trySetQueueTimestamp (schema, queues, column, seconds) {
  return `
    UPDATE ${schema}.queue
    SET ${column} = now()
    WHERE name IN(${getQueueInClause(queues)})
      AND EXTRACT( EPOCH FROM (now() - COALESCE(${column}, now() - interval '1 week') ) ) > ${seconds}
    RETURNING name    
  `
}

function updateQueue (schema, { deadLetter } = {}) {
  return `
    WITH options as (SELECT $2::jsonb as data)
    UPDATE ${schema}.queue SET
      retry_limit = COALESCE((o.data->>'retryLimit')::int, retry_limit),
      retry_delay = COALESCE((o.data->>'retryDelay')::int, retry_delay),
      retry_backoff = COALESCE((o.data->>'retryBackoff')::bool, retry_backoff),
      retry_delay_max = CASE WHEN o.data ? 'retryDelayMax'
        THEN (o.data->>'retryDelayMax')::int
        ELSE retry_delay_max END,
      expire_seconds = COALESCE((o.data->>'expireInSeconds')::int, expire_seconds),
      retention_seconds = COALESCE((o.data->>'retentionSeconds')::int, retention_seconds),
      deletion_seconds = COALESCE((o.data->>'deleteAfterSeconds')::int, deletion_seconds),
      warning_queued = COALESCE((o.data->>'warningQueueSize')::int, warning_queued),
      ${
        deadLetter === undefined
          ? ''
          : `dead_letter = CASE WHEN '${deadLetter}' IS DISTINCT FROM dead_letter THEN '${deadLetter}' ELSE dead_letter END,`
      }
      updated_on = now()
    FROM options o
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
      q.retry_delay_max as "retryDelayMax",
      q.expire_seconds as "expireInSeconds",
      q.retention_seconds as "retentionSeconds",
      q.deletion_seconds as "deleteAfterSeconds",
      q.partition,
      q.dead_letter as "deadLetter",
      q.deferred_count as "deferredCount",
      q.warning_queued as "warningQueueSize",
      q.queued_count as "queuedCount",
      q.active_count as "activeCount",
      q.total_count as "totalCount",
      q.singletons_active as "singletonsActive",
      q.table_name as "table",
      q.created_on as "createdOn",
      q.updated_on as "updatedOn"
    FROM ${schema}.queue q
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

function deleteQueuedJobs (schema, table) {
  return `DELETE from ${schema}.${table} WHERE name = $1 and state < '${JOB_STATES.active}'`
}

function deleteStoredJobs (schema, table) {
  return `DELETE from ${schema}.${table} WHERE name = $1 and state > '${JOB_STATES.active}'`
}

function truncateTable (schema, table) {
  return `TRUNCATE ${schema}.${table}`
}

function deleteAllJobs (schema, table) {
  return `DELETE from ${schema}.${table} WHERE name = $1`
}

function getSchedules (schema) {
  return `SELECT * FROM ${schema}.schedule`
}

function getSchedulesByQueue (schema) {
  return `SELECT * FROM ${schema}.schedule WHERE name = $1 AND COALESCE(key, '') = $2`
}

function schedule (schema) {
  return `
    INSERT INTO ${schema}.schedule (name, key, cron, timezone, data, options)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (name, key) DO UPDATE SET
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
      AND COALESCE(key, '') = $2
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

function fetchNextJob ({ schema, table, name, policy, limit, includeMetadata, priority = true, ignoreStartAfter = false, ignoreSingletons = null }) {
  const singletonFetch = limit > 1 && (policy === QUEUE_POLICIES.singleton || policy === QUEUE_POLICIES.stately)
  const cte = singletonFetch ? 'grouped' : 'next'

  return `
    WITH next as (
      SELECT id ${singletonFetch ? ', singleton_key' : ''}
      FROM ${schema}.${table}
      WHERE name = '${name}'
        AND state < '${JOB_STATES.active}'
        ${ignoreStartAfter ? '' : 'AND start_after < now()'}
        ${ignoreSingletons?.length > 0 ? `AND singleton_key NOT IN (${ignoreSingletons.map(i => `'${i}'`).join()})` : ''}
      ORDER BY ${priority ? 'priority desc, ' : ''}created_on, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    ${singletonFetch ? ', grouped as ( SELECT id, row_number() OVER (PARTITION BY singleton_key) FROM next)' : ''}
    UPDATE ${schema}.${table} j SET
      state = '${JOB_STATES.active}',
      started_on = now(),
      retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
    FROM ${cte}
    WHERE name = '${name}' AND j.id = ${cte}.id
      ${singletonFetch ? ` AND ${cte}.row_number = 1` : ''}
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

function insertJobs (schema, { table, name, returnId = true }) {
  const sql = `
    INSERT INTO ${schema}.${table} (
      id,
      name,
      data,
      priority,
      start_after,
      singleton_key,
      singleton_on,
      expire_seconds,
      deletion_seconds,
      keep_until,
      retry_limit,
      retry_delay,
      retry_backoff,
      retry_delay_max,
      policy,
      dead_letter
    )
    SELECT
      COALESCE(id, gen_random_uuid()) as id,
      '${name}' as name,
      data,
      COALESCE(priority, 0) as priority,
      j.start_after,
      "singletonKey",
      CASE
        WHEN "singletonSeconds" IS NOT NULL THEN 'epoch'::timestamp + '1s'::interval * ("singletonSeconds" * floor(( date_part('epoch', now()) + COALESCE("singletonOffset",0)) / "singletonSeconds" ))
        ELSE NULL
        END as singleton_on,
      COALESCE("expireInSeconds", q.expire_seconds) as expire_seconds,
      COALESCE("deleteAfterSeconds", q.deletion_seconds) as deletion_seconds,
      j.start_after + (COALESCE("retentionSeconds", q.retention_seconds) * interval '1s') as keep_until,
      COALESCE("retryLimit", q.retry_limit) as retry_limit,
      COALESCE("retryDelay", q.retry_delay) as retry_delay,
      COALESCE("retryBackoff", q.retry_backoff, false) as retry_backoff,
      COALESCE("retryDelayMax", q.retry_delay_max) as retry_delay_max,
      q.policy,
      q.dead_letter
    FROM (
      SELECT *,
        CASE
          WHEN right("startAfter", 1) = 'Z' THEN CAST("startAfter" as timestamp with time zone)
          ELSE now() + CAST(COALESCE("startAfter",'0') as interval)
          END as start_after
      FROM json_to_recordset($1::json) as x (
        id uuid,
        name text,
        priority integer,
        data jsonb,
        "startAfter" text,
        "retryLimit" integer,
        "retryDelay" integer,
        "retryDelayMax" integer,
        "retryBackoff" boolean,
        "singletonKey" text,
        "singletonSeconds" integer,
        "singletonOffset" integer,
        "expireInSeconds" integer,
        "deleteAfterSeconds" integer,
        "retentionSeconds" integer
      ) 
    ) j
    JOIN ${schema}.queue q ON q.name = '${name}'
    ON CONFLICT DO NOTHING
    ${returnId ? 'RETURNING id' : ''}
  `

  return sql
}

function failJobsById (schema, table) {
  const where = `name = $1 AND id IN (SELECT UNNEST($2::uuid[])) AND state < '${JOB_STATES.completed}'`
  const output = '$3::jsonb'

  return failJobs(schema, table, where, output)
}

function failJobsByTimeout (schema, table, queues) {
  const where = `state = '${JOB_STATES.active}'
            AND (started_on + expire_seconds * interval '1s') < now()
            AND name IN (${getQueueInClause(queues)})`

  const output = '\'{ "value": { "message": "job timed out" } }\'::jsonb'

  return locked(schema, failJobs(schema, table, where, output), table + 'failJobsByTimeout')
}

function failJobs (schema, table, where, output) {
  return `
    WITH deleted_jobs AS (
      DELETE FROM ${schema}.${table}
      WHERE ${where}
      RETURNING *
    ),
    retried_jobs AS (
      INSERT INTO ${schema}.${table} (
        id,
        name,
        priority,
        data,
        state,
        retry_limit,
        retry_count,
        retry_delay,
        retry_backoff,
        retry_delay_max,
        start_after,
        started_on,
        singleton_key,
        singleton_on,
        expire_seconds,
        deletion_seconds,
        created_on,
        completed_on,
        keep_until,
        policy,
        output,
        dead_letter
      )
      SELECT
        id,
        name,
        priority,
        data,
        CASE
          WHEN retry_count < retry_limit THEN '${JOB_STATES.retry}'::${schema}.job_state
          ELSE '${JOB_STATES.failed}'::${schema}.job_state
          END as state,
        retry_limit,
        retry_count,
        retry_delay,
        retry_backoff,
        retry_delay_max,
        CASE WHEN retry_count = retry_limit THEN start_after
             WHEN NOT retry_backoff THEN now() + retry_delay * interval '1'
             ELSE now() + LEAST(
               retry_delay_max,
               retry_delay + (
                2 ^ LEAST(16, retry_count + 1) / 2 +
                2 ^ LEAST(16, retry_count + 1) / 2 * random()
               )
             ) * interval '1s'
        END as start_after,
        started_on,
        singleton_key,
        singleton_on,
        expire_seconds,
        deletion_seconds,
        created_on,
        CASE WHEN retry_count < retry_limit THEN NULL ELSE now() END as completed_on,
        keep_until,
        policy,
        ${output},
        dead_letter
      FROM deleted_jobs
      ON CONFLICT DO NOTHING
      RETURNING *
    ),
    failed_jobs as (
      INSERT INTO ${schema}.${table} (
        id,
        name,
        priority,
        data,
        state,
        retry_limit,
        retry_count,
        retry_delay,
        retry_backoff,
        retry_delay_max,
        start_after,
        started_on,
        singleton_key,
        singleton_on,
        expire_seconds,
        deletion_seconds,
        created_on,
        completed_on,
        keep_until,
        policy,
        output,
        dead_letter
      )
      SELECT
        id,
        name,
        priority,
        data,
        '${JOB_STATES.failed}'::${schema}.job_state as state,
        retry_limit,
        retry_count,
        retry_delay,
        retry_backoff,
        retry_delay_max,
        start_after,
        started_on,
        singleton_key,
        singleton_on,
        expire_seconds,
        deletion_seconds,
        created_on,
        now() as completed_on,
        keep_until,
        policy,
        ${output},
        dead_letter
      FROM deleted_jobs
      WHERE id NOT IN (SELECT id from retried_jobs)
      RETURNING *
    ),
    results as (
      SELECT * FROM retried_jobs
      UNION ALL
      SELECT * FROM failed_jobs
    ),
    dlq_jobs as (
      INSERT INTO ${schema}.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds)
      SELECT
        r.dead_letter,
        data,
        output,
        q.retry_limit,
        q.retry_backoff,
        q.retry_delay,
        now() + q.retention_seconds * interval '1s',
        q.deletion_seconds
      FROM results r
        JOIN ${schema}.queue q ON q.name = r.dead_letter
      WHERE state = '${JOB_STATES.failed}'
    )
    SELECT COUNT(*) FROM results
  `
}

function deletion (schema, table, queues) {
  const sql = `
    DELETE FROM ${schema}.${table}
    WHERE name IN (${getQueueInClause(queues)})
      AND
      (
        completed_on + deletion_seconds * interval '1s' < now()
        OR
        (state < '${JOB_STATES.active}' AND keep_until < now())
      )        
  `

  return locked(schema, sql, table + 'deletion')
}

function retryJobs (schema) {
  return `
    WITH results as (
      UPDATE ${schema}.job
      SET state = '${JOB_STATES.retry}',
        retry_limit = retry_limit + 1
      WHERE name = $1
        AND id IN (SELECT UNNEST($2::uuid[]))
        AND state = '${JOB_STATES.failed}'
      RETURNING 1
    )
    SELECT COUNT(*) from results
  `
}

function getQueueStats (schema, table, queues) {
  return `
    SELECT
        name, 
        (count(*) FILTER (WHERE start_after > now()))::int as "deferredCount",
        (count(*) FILTER (WHERE state < '${JOB_STATES.active}'))::int as "queuedCount",
        (count(*) FILTER (WHERE state = '${JOB_STATES.active}'))::int as "activeCount",
        count(*)::int as "totalCount",
        array_agg(singleton_key) FILTER (WHERE policy IN ('${QUEUE_POLICIES.singleton}','${QUEUE_POLICIES.stately}') AND state = '${JOB_STATES.active}') as "singletonsActive"
      FROM ${schema}.${table}
      WHERE name IN (${getQueueInClause(queues)})
      GROUP BY 1
  `
}

function cacheQueueStats (schema, table, queues) {
  const sql = `
    WITH stats AS (${getQueueStats(schema, table, queues)})
    UPDATE ${schema}.queue SET
      deferred_count = "deferredCount",
      queued_count = "queuedCount",
      active_count = "activeCount",
      total_count = "totalCount",
      singletons_active = "singletonsActive"
    FROM stats
      WHERE queue.name = stats.name
    RETURNING
      queue.name,
      "queuedCount",
      warning_queued as "warningQueueSize"
  `

  return locked(schema, sql, 'queue-stats')
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

function getJobsByData (schema, table, onlyQueued) {
  return `SELECT ${JOB_COLUMNS_ALL} FROM ${schema}.${table} WHERE name = $1 AND data @> $2 ${onlyQueued ? ` AND state < '${JOB_STATES.active}'` : ''}`
}

function getQueueInClause (queues) {
  return queues.map(i => `'${i}'`).join(',')
}
