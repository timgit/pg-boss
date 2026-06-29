import type { UpdateQueueOptions } from './types.ts'

export interface SqlQuery {
  text: string
  values: unknown[]
}

export const PG_ERROR = {
  divisionByZero: '22012'
}

export const DEFAULT_SCHEMA = 'pgboss'
export const MIGRATE_RACE_MESSAGE = 'division by zero'
export const CREATE_RACE_MESSAGE = 'already exists'
const SINGLE_QUOTE_REGEX = /'/g
const FIFTEEN_MINUTES = 60 * 15
const FORTEEN_DAYS = 60 * 60 * 24 * 14
const SEVEN_DAYS = 60 * 60 * 24 * 7

export const JOB_STATES = Object.freeze({
  created: 'created',
  retry: 'retry',
  active: 'active',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed'
})

export const QUEUE_POLICIES = Object.freeze({
  standard: 'standard',
  short: 'short',
  singleton: 'singleton',
  stately: 'stately',
  exclusive: 'exclusive',
  key_strict_fifo: 'key_strict_fifo'
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

interface CreateOptions {
  createSchema?: boolean
  noTablePartitioning?: boolean
  noDeferrableConstraints?: boolean
  noAdvisoryLocks?: boolean
  noCoveringIndexes?: boolean
}

export function create (schema: string, version: number, options?: CreateOptions) {
  const noPartitioning = options?.noTablePartitioning ?? false
  const noDeferrable = options?.noDeferrableConstraints ?? false
  const noLocks = options?.noAdvisoryLocks ?? false
  const noCovering = options?.noCoveringIndexes ?? false

  const commands = [
    options?.createSchema ? createSchema(schema) : '',
    createEnumJobState(schema),

    createTableVersion(schema),
    createTableQueue(schema),
    createTableSchedule(schema),
    createTableSubscription(schema),
    createTableBam(schema),

    // Partition-helper functions are only used by the partitioned architecture.
    // They are unused when partitioning is disabled, and job_table_format's
    // IMMUTABLE + format() body is rejected at create time by databases like
    // CockroachDB, so skip them entirely in noTablePartitioning mode.
    noPartitioning ? '' : jobTableFormatFunction(schema),
    noPartitioning ? '' : jobTableRunFunction(schema),
    noPartitioning ? '' : jobTableRunAsyncFunction(schema),

    createTableJob(schema, noPartitioning),
    createPrimaryKeyJob(schema),
    noPartitioning ? createTableJobIndexes(schema, noDeferrable, noCovering) : createTableJobCommon(schema),

    createTableWarning(schema),
    createIndexWarning(schema),

    createTableQueueStats(schema, noPartitioning),
    createIndexQueueStats(schema, noCovering),
    noPartitioning ? '' : ensureQueueStatsPartitions(schema),

    createTableJobDependency(schema),
    createIndexJobDependencyParent(schema),

    createQueueFunction(schema, noPartitioning),
    deleteQueueFunction(schema, noPartitioning),

    insertVersion(schema, version)
  ]

  return locked(schema, commands, undefined, noLocks)
}

function createSchema (schema: string) {
  return `CREATE SCHEMA IF NOT EXISTS ${schema}`
}

function createEnumJobState (schema: string) {
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

function createTableVersion (schema: string) {
  return `
    CREATE TABLE ${schema}.version (
      version int primary key,
      cron_on timestamp with time zone,
      bam_on timestamp with time zone,
      flow_on timestamp with time zone
    )
  `
}

function createTableQueue (schema: string) {
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
      ready_count int NOT NULL default 0,
      warning_queued int NOT NULL default 0,
      active_count int NOT NULL default 0,
      failed_count int NOT NULL default 0,
      total_count int NOT NULL default 0,
      ready_history int[] NOT NULL default '{}',
      heartbeat_seconds int,
      notify bool NOT NULL DEFAULT false,
      singletons_active text[],
      monitor_on timestamp with time zone,
      maintain_on timestamp with time zone,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name)
    )
  `
}

function createTableSchedule (schema: string) {
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

function createTableSubscription (schema: string) {
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

function createTableBam (schema: string) {
  return `
    CREATE TABLE ${schema}.bam (
      id uuid PRIMARY KEY default gen_random_uuid(),
      name text NOT NULL,
      version int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      queue text,
      table_name text NOT NULL,
      command text NOT NULL,
      error text,
      created_on timestamp with time zone NOT NULL DEFAULT now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone
    )
  `
}

export function createTableWarning (schema: string) {
  return `
    CREATE TABLE ${schema}.warning (
      id uuid PRIMARY KEY default gen_random_uuid(),
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamp with time zone NOT NULL DEFAULT now()
    )
  `
}

export function createIndexWarning (schema: string) {
  return `CREATE INDEX warning_i1 ON ${schema}.warning (created_on DESC)`
}

export function createTableJobDependency (schema: string) {
  return `
    CREATE TABLE ${schema}.job_dependency (
      child_name text NOT NULL,
      child_id uuid NOT NULL,
      parent_name text NOT NULL,
      parent_id uuid NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )
  `
}

export function createIndexJobDependencyParent (schema: string) {
  return `CREATE INDEX IF NOT EXISTS job_dep_parent_idx ON ${schema}.job_dependency (parent_name, parent_id)`
}

function jobTableFormatFunction (schema: string) {
  return `
    CREATE FUNCTION ${schema}.job_table_format(command text, table_name text)
    RETURNS text AS
    $$
      SELECT format(
        replace(
          replace(command, '.job', '.%1$I'),
          'job_i', '%1$s_i'
        ),
        table_name
      );
    $$
    LANGUAGE sql IMMUTABLE;
  `
}

function jobTableRunFunction (schema: string) {
  return `
    CREATE FUNCTION ${schema}.job_table_run(command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM ${schema}.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE ${schema}.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE ${schema}.job_table_format(command, '${COMMON_JOB_TABLE}');

      FOR tbl IN SELECT table_name FROM ${schema}.queue WHERE partition = true
      LOOP
        EXECUTE ${schema}.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$
    LANGUAGE plpgsql;
  `
}

function jobTableRunAsyncFunction (schema: string) {
  return `
    CREATE FUNCTION ${schema}.job_table_run_async(command_name text, version int, command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM ${schema}.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO ${schema}.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          ${schema}.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO ${schema}.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        '${COMMON_JOB_TABLE}',
        ${schema}.job_table_format(command, '${COMMON_JOB_TABLE}')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        ${schema}.job_table_format(command, queue.table_name)
      FROM ${schema}.queue
      WHERE partition = true;
    END;
    $$
    LANGUAGE plpgsql;
  `
}

function createTableJob (schema: string, noPartitioning = false) {
  const partitionClause = noPartitioning ? '' : 'PARTITION BY LIST (name)'
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
      group_id text,
      group_tier text,
      start_after timestamp with time zone not null default now(),
      created_on timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '${QUEUE_DEFAULTS.retention_seconds}',
      output jsonb,
      dead_letter text,
      policy text,
      heartbeat_on timestamp with time zone,
      heartbeat_seconds int,
      blocked boolean not null default false,
      blocking boolean not null default false,
      pending_dependencies int not null default 0,
      source_name text,
      source_id uuid,
      source_created_on timestamp with time zone,
      source_retry_count int
    ) ${partitionClause}
  `
}

const JOB_COLUMNS_MIN = 'id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"'
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
  heartbeat_on as "heartbeatOn",
  created_on as "createdOn",
  completed_on as "completedOn",
  keep_until as "keepUntil",
  dead_letter as "deadLetter",
  blocked,
  blocking,
  pending_dependencies as "pendingDependencies",
  output,
  source_name as "sourceName",
  source_id as "sourceId",
  source_created_on as "sourceCreatedOn",
  source_retry_count as "sourceRetryCount"
`

function createTableJobCommon (schema: string) {
  return `
    CREATE TABLE ${schema}.${COMMON_JOB_TABLE} (LIKE ${schema}.job INCLUDING GENERATED INCLUDING DEFAULTS);

    SELECT ${schema}.job_table_run($cmd$${createPrimaryKeyJob(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createQueueForeignKeyJob(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createQueueForeignKeyJobDeadLetter(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createIndexJobPolicyShort(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createIndexJobPolicySingleton(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createIndexJobPolicyStately(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createIndexJobPolicyExclusive(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createIndexJobPolicyKeyStrictFifo(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createCheckConstraintKeyStrictFifo(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createIndexJobThrottle(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createIndexJobFetch(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createIndexJobGroupConcurrency(schema)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${schema}.job_table_run($cmd$${createIndexJobBlocking(schema)}$cmd$, '${COMMON_JOB_TABLE}');

    ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.${COMMON_JOB_TABLE} DEFAULT;
  `
}

// Creates indexes directly on job table when partitioning is disabled
function createTableJobIndexes (schema: string, noDeferrableConstraints = false, noCoveringIndex = false) {
  return `
    ${createQueueForeignKeyJob(schema, noDeferrableConstraints)};
    ${createQueueForeignKeyJobDeadLetter(schema, noDeferrableConstraints)};
    ${createIndexJobPolicyShort(schema)};
    ${createIndexJobPolicySingleton(schema)};
    ${createIndexJobPolicyStately(schema)};
    ${createIndexJobPolicyExclusive(schema)};
    ${createIndexJobPolicyKeyStrictFifo(schema)};
    ${createCheckConstraintKeyStrictFifo(schema)};
    ${createIndexJobThrottle(schema)};
    ${createIndexJobFetch(schema, noCoveringIndex)};
    ${createIndexJobGroupConcurrency(schema)};
    ${createIndexJobBlocking(schema)};
  `
}

function createQueueFunction (schema: string, noPartitioning = false) {
  if (noPartitioning) {
    // Simplified version without table partitioning support
    return `
      CREATE FUNCTION ${schema}.create_queue(queue_name text, options jsonb)
      RETURNS VOID AS
      $$
      BEGIN
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
          table_name,
          heartbeat_seconds
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
          false,
          'job',
          (options->>'heartbeatSeconds')::int
        )
        ON CONFLICT DO NOTHING;
      END;
      $$
      LANGUAGE plpgsql;
    `
  }

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
          table_name,
          heartbeat_seconds,
          notify
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
          tablename,
          (options->>'heartbeatSeconds')::int,
          COALESCE((options->>'notify')::bool, false)
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE ${schema}.%I (LIKE ${schema}.job INCLUDING DEFAULTS)', tablename);

      EXECUTE ${schema}.job_table_format($cmd$${createPrimaryKeyJob(schema)}$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$${createQueueForeignKeyJob(schema)}$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$${createQueueForeignKeyJobDeadLetter(schema)}$cmd$, tablename);

      EXECUTE ${schema}.job_table_format($cmd$${createIndexJobFetch(schema)}$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$${createIndexJobThrottle(schema)}$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$${createIndexJobGroupConcurrency(schema)}$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$${createIndexJobBlocking(schema)}$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE ${schema}.job_table_format($cmd$${createIndexJobPolicyShort(schema)}$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE ${schema}.job_table_format($cmd$${createIndexJobPolicySingleton(schema)}$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE ${schema}.job_table_format($cmd$${createIndexJobPolicyStately(schema)}$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE ${schema}.job_table_format($cmd$${createIndexJobPolicyExclusive(schema)}$cmd$, tablename);
      ELSIF options->>'policy' = '${QUEUE_POLICIES.key_strict_fifo}' THEN
        EXECUTE ${schema}.job_table_format($cmd$${createIndexJobPolicyKeyStrictFifo(schema)}$cmd$, tablename);
        EXECUTE ${schema}.job_table_format($cmd$${createCheckConstraintKeyStrictFifo(schema)}$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `
}

function deleteQueueFunction (schema: string, noPartitioning = false) {
  const deleteJobsSql = noPartitioning
    ? `DELETE FROM ${schema}.job WHERE name = queue_name;`
    : `
      SELECT table_name, partition
      FROM ${schema}.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS ${schema}.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM ${schema}.%I WHERE name = %L', v_table, queue_name);
      END IF;
    `

  const declareBlock = noPartitioning
    ? ''
    : `
    DECLARE
      v_table varchar;
      v_partition bool;`

  return `
    CREATE FUNCTION ${schema}.delete_queue(queue_name text)
    RETURNS VOID AS
    $$${declareBlock}
    BEGIN
      ${deleteJobsSql}
      DELETE FROM ${schema}.queue WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  `
}

export function createQueue (schema: string, name: string, options: unknown, noAdvisoryLocks?: boolean) {
  const sql = `SELECT ${schema}.create_queue('${name}', '${JSON.stringify(options)}'::jsonb)`
  return locked(schema, sql, 'create-queue', noAdvisoryLocks)
}

// LISTEN/NOTIFY channels share a single database-global namespace and are limited to
// NAMEDATALEN (63 bytes), unlike the rest of pg-boss which is schema-bound. Derive a
// stable, collision-resistant channel from the schema so separate pg-boss instances
// (and other services) on the same database never clash. Payload carries the queue name.
//
// Returns a SQL scalar expression (not a value) hashed in-database with sha224, matching
// the convention used by advisoryLock() and partition table naming. Both the producer
// (inlined into the insert) and the listener (resolved once at startup) derive the channel
// from this single expression, so they always agree. The 'pgboss_' prefix keeps the
// channel human-recognizable in pg_stat_activity; 24 hex chars leaves ample headroom under
// the 63-byte identifier limit. Channels are already scoped to a single database, so unlike
// advisoryLock there is no need to mix in current_database().
export function notifyChannelSql (schema: string): string {
  return `('pgboss_' || left(encode(sha224('${schema}'::bytea), 'hex'), 24))`
}

// Parameter-less statement that wakes workers on a notify-enabled queue. Embedded into
// flow batches so it commits in the same transaction as the inserts.
export function notifyQueue (schema: string, name: string): string {
  return `SELECT pg_notify(${notifyChannelSql(schema)}, '${name}')`
}

export function deleteQueue (schema: string, name: string, noAdvisoryLocks?: boolean) {
  const sql = `SELECT ${schema}.delete_queue('${name}')`
  return locked(schema, sql, 'delete-queue', noAdvisoryLocks)
}

function createPrimaryKeyJob (schema: string) {
  return `ALTER TABLE ${schema}.job ADD PRIMARY KEY (name, id)`
}

function createQueueForeignKeyJob (schema: string, noPartitioning = false) {
  const deferrable = noPartitioning ? '' : ' DEFERRABLE INITIALLY DEFERRED'
  return `ALTER TABLE ${schema}.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT${deferrable}`
}

function createQueueForeignKeyJobDeadLetter (schema: string, noPartitioning = false) {
  const deferrable = noPartitioning ? '' : ' DEFERRABLE INITIALLY DEFERRED'
  return `ALTER TABLE ${schema}.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT${deferrable}`
}

function createIndexJobPolicyShort (schema: string) {
  return `CREATE UNIQUE INDEX job_i1 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = '${JOB_STATES.created}' AND policy = '${QUEUE_POLICIES.short}'`
}

function createIndexJobPolicySingleton (schema: string) {
  return `CREATE UNIQUE INDEX job_i2 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = '${JOB_STATES.active}' AND policy = '${QUEUE_POLICIES.singleton}'`
}

function createIndexJobPolicyStately (schema: string) {
  return `CREATE UNIQUE INDEX job_i3 ON ${schema}.job (name, state, COALESCE(singleton_key, '')) WHERE state <= '${JOB_STATES.active}' AND policy = '${QUEUE_POLICIES.stately}'`
}

function createIndexJobThrottle (schema: string) {
  return `CREATE UNIQUE INDEX job_i4 ON ${schema}.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> '${JOB_STATES.cancelled}' AND singleton_on IS NOT NULL`
}

function createIndexJobFetch (schema: string, noCoveringIndex = false) {
  // No covering INCLUDE: the fetch locks candidate rows with FOR UPDATE ... SKIP LOCKED, which
  // forces heap access, so an index-only scan is impossible and a covering payload would never be
  // read from the index. Confirmed dead weight via EXPLAIN ANALYZE (see examples/index-perf);
  // dropping it shrinks job_i5 on the hot insert path at no read-side cost.
  // noCoveringIndex (the CockroachDB profile flag that stripped the old INCLUDE) is now moot here.
  return `CREATE INDEX job_i5 ON ${schema}.job (name, start_after) WHERE state < '${JOB_STATES.active}' AND NOT blocked`
}

function createIndexJobPolicyExclusive (schema: string) {
  return `CREATE UNIQUE INDEX job_i6 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state <= '${JOB_STATES.active}' AND policy = '${QUEUE_POLICIES.exclusive}'`
}

function createIndexJobPolicyKeyStrictFifo (schema: string) {
  return `CREATE UNIQUE INDEX job_i8 ON ${schema}.job (name, singleton_key) WHERE state IN ('${JOB_STATES.active}', '${JOB_STATES.retry}', '${JOB_STATES.failed}') AND policy = '${QUEUE_POLICIES.key_strict_fifo}'`
}

function createCheckConstraintKeyStrictFifo (schema: string) {
  return `ALTER TABLE ${schema}.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = '${QUEUE_POLICIES.key_strict_fifo}' AND singleton_key IS NULL))`
}

function createIndexJobGroupConcurrency (schema: string) {
  return `CREATE INDEX job_i7 ON ${schema}.job (name, group_id) WHERE state = '${JOB_STATES.active}' AND group_id IS NOT NULL`
}

// Partial index supporting the background flow resolver (Navigator): lets it find completed
// blocking parents with an index scan instead of a partition-wide scan. The `state = completed`
// predicate keeps still-running and permanently-failed blocking parents out of the index, so
// non-flow queues (and high-partition-count deployments) carry an empty index that costs nothing.
function createIndexJobBlocking (schema: string) {
  return `CREATE INDEX job_i9 ON ${schema}.job (name, id) WHERE blocking AND state = '${JOB_STATES.completed}'`
}

export function trySetQueueMonitorTime (schema: string, queues: string[], seconds: number): SqlQuery {
  return trySetQueueTimestamp(schema, queues, 'monitor_on', seconds)
}

export function trySetQueueDeletionTime (schema: string, queues: string[], seconds: number): SqlQuery {
  return trySetQueueTimestamp(schema, queues, 'maintain_on', seconds)
}

export function trySetCronTime (schema: string, seconds: number) {
  return trySetTimestamp(schema, 'cron_on', seconds)
}

export function trySetBamTime (schema: string, seconds: number) {
  return trySetTimestamp(schema, 'bam_on', seconds)
}

export function trySetFlowTime (schema: string, seconds: number) {
  return trySetTimestamp(schema, 'flow_on', seconds)
}

function trySetTimestamp (schema: string, column: string, seconds: number) {
  return `
    UPDATE ${schema}.version
    SET ${column} = now()
    WHERE EXTRACT( EPOCH FROM (now() - COALESCE(${column}, now() - interval '1 week') ) ) > ${seconds}
    RETURNING true
  `
}

function trySetQueueTimestamp (schema: string, queues: string[], column: string, seconds: number): SqlQuery {
  return {
    text: `
    UPDATE ${schema}.queue
    SET ${column} = now()
    WHERE name = ANY($1::text[])
      AND EXTRACT( EPOCH FROM (now() - COALESCE(${column}, now() - interval '1 week') ) ) > ${seconds}
    RETURNING name
  `,
    values: [queues]
  }
}

export function updateQueue (schema: string, { deadLetter }: UpdateQueueOptions = {}) {
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
      heartbeat_seconds = CASE WHEN o.data ? 'heartbeatSeconds'
        THEN (o.data->>'heartbeatSeconds')::int
        ELSE heartbeat_seconds END,
      notify = COALESCE((o.data->>'notify')::bool, notify),
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

export function getQueues (schema: string, names?: string[]): SqlQuery {
  const hasNames = names && names.length > 0
  return {
    text: `
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
      q.heartbeat_seconds as "heartbeatSeconds",
      q.notify,
      q.dead_letter as "deadLetter",
      q.deferred_count as "deferredCount",
      q.warning_queued as "warningQueueSize",
      q.queued_count as "queuedCount",
      q.ready_count as "readyCount",
      q.active_count as "activeCount",
      q.failed_count as "failedCount",
      q.total_count as "totalCount",
      q.singletons_active as "singletonsActive",
      q.table_name as "table",
      q.created_on as "createdOn",
      q.updated_on as "updatedOn"
    FROM ${schema}.queue q
    ${hasNames ? 'WHERE q.name = ANY($1::text[])' : ''}
   `,
    values: hasNames ? [names] : []
  }
}

export function deleteJobsById (schema: string, table: string) {
  return `
    WITH results as (
      DELETE FROM ${schema}.${table}
      WHERE name = $1
        AND id = ANY($2::uuid[])
      RETURNING 1
    )
    SELECT COUNT(*) from results
  `
}

export function deleteQueuedJobs (schema: string, table: string) {
  return `DELETE from ${schema}.${table} WHERE name = $1 and state < '${JOB_STATES.active}'`
}

export function deleteStoredJobs (schema: string, table: string) {
  return `DELETE from ${schema}.${table} WHERE name = $1 and state > '${JOB_STATES.active}'`
}

export function truncateTable (schema: string, table: string) {
  return `TRUNCATE ${schema}.${table}`
}

export function deleteAllJobs (schema: string, table: string) {
  return `DELETE from ${schema}.${table} WHERE name = $1`
}

export function getSchedules (schema: string) {
  return `SELECT * FROM ${schema}.schedule ORDER BY name, key`
}

export function getSchedulesByQueue (schema: string) {
  return `SELECT * FROM ${schema}.schedule WHERE name = $1 AND COALESCE(key, '') = $2`
}

export function schedule (schema: string) {
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

export function unschedule (schema: string) {
  return `
    DELETE FROM ${schema}.schedule
    WHERE name = $1
      AND COALESCE(key, '') = $2
  `
}

export function subscribe (schema: string) {
  return `
    INSERT INTO ${schema}.subscription (event, name)
    VALUES ($1, $2)
    ON CONFLICT (event, name) DO UPDATE SET
      event = EXCLUDED.event,
      name = EXCLUDED.name,
      updated_on = now()
  `
}

export function unsubscribe (schema: string) {
  return `
    DELETE FROM ${schema}.subscription
    WHERE event = $1 and name = $2
  `
}

export function getQueuesForEvent (schema: string) {
  return `
    SELECT name FROM ${schema}.subscription
    WHERE event = $1
  `
}

export function getTime () {
  return "SELECT round(date_part('epoch', now()) * 1000) as time"
}

export function insertWarning (schema: string) {
  return `
    INSERT INTO ${schema}.warning (type, message, data)
    VALUES ($1, $2, $3)
  `
}

export function getWarnings (schema: string): string {
  return `
    SELECT
      id,
      type,
      message,
      data,
      created_on as "createdOn"
    FROM ${schema}.warning
    WHERE ($1::text IS NULL OR type = $1)
    ORDER BY created_on DESC
    LIMIT $2 OFFSET $3
  `
}

export function getWarningsCount (schema: string): string {
  return `
    SELECT COUNT(*)::int as count
    FROM ${schema}.warning
    WHERE ($1::text IS NULL OR type = $1)
  `
}

export function deleteOldWarnings (schema: string, days: number): string {
  return `
    DELETE FROM ${schema}.warning
    WHERE created_on < now() - interval '${days} days'
  `
}

export function createTableQueueStats (schema: string, noPartitioning = false): string {
  if (noPartitioning) {
    return `
      CREATE TABLE ${schema}.queue_stats (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        name text NOT NULL,
        deferred_count int NOT NULL DEFAULT 0,
        queued_count   int NOT NULL DEFAULT 0,
        ready_count    int NOT NULL DEFAULT 0,
        active_count   int NOT NULL DEFAULT 0,
        failed_count   int NOT NULL DEFAULT 0,
        total_count    int NOT NULL DEFAULT 0,
        captured_on timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id)
      )
    `
  }
  return `
    CREATE TABLE ${schema}.queue_stats (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      name text NOT NULL,
      deferred_count int NOT NULL DEFAULT 0,
      queued_count   int NOT NULL DEFAULT 0,
      ready_count    int NOT NULL DEFAULT 0,
      active_count   int NOT NULL DEFAULT 0,
      failed_count   int NOT NULL DEFAULT 0,
      total_count    int NOT NULL DEFAULT 0,
      captured_on timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, captured_on)
    ) PARTITION BY RANGE (captured_on)
  `
}

// queue_stats_i1 serves both the raw history query and the bucketed aggregates: the filter
// (name = ?, captured_on range) rides the composite key, and the six count columns are carried as
// covering payload so those reads run index-only (no per-row heap fetch — the dominant cost when an
// aggregate scans many rows). INCLUDE is gated on the noCoveringIndexes profile flag, which
// CockroachDB sets (it uses STORING, not INCLUDE) but YugabyteDB does not (it supports INCLUDE):
// the gated backends keep the plain composite index — correct, just not covering.
export function createIndexQueueStats (schema: string, noCoveringIndex = false): string {
  const cols = '(name, captured_on DESC)'
  const include = 'INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count)'
  return noCoveringIndex
    ? `CREATE INDEX queue_stats_i1 ON ${schema}.queue_stats ${cols}`
    : `CREATE INDEX queue_stats_i1 ON ${schema}.queue_stats ${cols} ${include}`
}

// Idempotently create the daily partitions for today and tomorrow (UTC). Both the day suffix and
// the range bounds are derived in SQL from the UTC calendar date, and the bounds are emitted as
// explicit `+00` timestamptz literals. This keeps partitioning correct regardless of the database
// session TimeZone (a bare date literal like '2026-06-25' would otherwise be cast to timestamptz in
// the session TZ, so rows written near UTC midnight could fall outside every existing partition).
// Computing the date in SQL (rather than interpolating new Date()) also keeps emitted DDL — including
// the v35 migration and exported create plans — deterministic and apply-time accurate.
export function ensureQueueStatsPartitions (schema: string): string {
  return `
    DO $$
    DECLARE
      d date;
      i int;
      part_name text;
    BEGIN
      FOR i IN 0..1 LOOP
        d := (now() AT TIME ZONE 'UTC')::date + i;
        part_name := 'queue_stats_' || to_char(d, 'YYYYMMDD');
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = '${schema}' AND c.relname = part_name
        ) THEN
          EXECUTE format(
            'CREATE TABLE ${schema}.%I PARTITION OF ${schema}.queue_stats FOR VALUES FROM (%L) TO (%L)',
            part_name,
            to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
          );
        END IF;
      END LOOP;
    END;
    $$
  `
}

export function dropOldQueueStatsPartitions (schema: string, days: number): string {
  return `
    DO $$
    DECLARE
      r record;
      cutoff date := (now() AT TIME ZONE 'UTC')::date - ${days};
      suffix text;
      part_date date;
    BEGIN
      FOR r IN
        SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = p.relnamespace
        WHERE n.nspname = '${schema}' AND p.relname = 'queue_stats'
      LOOP
        suffix := substring(r.relname FROM 'queue_stats_(.*)$');
        IF suffix ~ '^[0-9]{8}$' THEN
          part_date := to_date(suffix, 'YYYYMMDD');
          IF part_date < cutoff THEN
            EXECUTE 'DROP TABLE IF EXISTS ${schema}.' || quote_ident(r.relname);
          END IF;
        END IF;
      END LOOP;
    END;
    $$
  `
}

export function deleteOldQueueStats (schema: string, days: number): string {
  return `
    DELETE FROM ${schema}.queue_stats
    WHERE captured_on < now() - interval '${days} days'
  `
}

export function insertQueueStats (schema: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const sql = `
    INSERT INTO ${schema}.queue_stats
      (name, deferred_count, queued_count, ready_count, active_count, failed_count, total_count)
    SELECT name, deferred_count, queued_count, ready_count, active_count, failed_count, total_count
    FROM ${schema}.queue
    WHERE name = ANY(${serializeArrayParam(queues)})
  `
  return locked(schema, sql, 'queue-stats-insert', noAdvisoryLocks)
}

// Cheap single-row read of the cached counts the monitor maintains on the queue table. capturedOn
// is monitor_on — the moment those counts were last refreshed, or NULL if the queue has never been
// monitored (so the caller knows to recompute rather than trust default-zero counts).
export function getQueueStatsCache (schema: string): string {
  return `
    SELECT
      name,
      deferred_count as "deferredCount",
      queued_count   as "queuedCount",
      ready_count    as "readyCount",
      active_count   as "activeCount",
      failed_count   as "failedCount",
      total_count    as "totalCount",
      table_name     as "table",
      monitor_on     as "capturedOn"
    FROM ${schema}.queue
    WHERE name = $1
  `
}

export function getQueueStatsHistory (schema: string): string {
  return `
    SELECT
      name,
      deferred_count as "deferredCount",
      queued_count   as "queuedCount",
      ready_count    as "readyCount",
      active_count   as "activeCount",
      failed_count   as "failedCount",
      total_count    as "totalCount",
      captured_on    as "capturedOn"
    FROM ${schema}.queue_stats
    WHERE name = $1
      AND ($2::timestamptz IS NULL OR captured_on >= $2)
      AND ($3::timestamptz IS NULL OR captured_on <= $3)
    ORDER BY captured_on DESC
    LIMIT $4
  `
}

// Per-bucket aggregate over a count column. The function name can't be a bind parameter, so it's
// interpolated — safe because the manager validates `aggregate` against this whitelist first. Every
// result is cast back to int: it honors the int count contract (avg rounds) and keeps Postgres
// returning the value as a JS number rather than a numeric string.
const STATS_AGG = {
  max: (c: string) => `max(${c})::int`,
  min: (c: string) => `min(${c})::int`,
  avg: (c: string) => `round(avg(${c}))::int`
} as const

// Downsampled history: group the recorded series into fixed-width time buckets and collapse each
// bucket's counts with `aggregate`, so a wide window returns a manageable, representative sample
// instead of just the newest `limit` raw rows.
//
//   mode 'bucket' — $5 is the bucket width in seconds (explicit resolution).
//   mode 'auto'   — $5 is maxDataPoints; the width is derived so the series fits in $5 points.
//                   from/to sets the range, but they cannot exceed the data's own min/max values.
//
// The bucket key avoids date_bin() (PG14+): pg-boss supports PostgreSQL 13+ and CockroachDB/
// YugabyteDB, none of which can rely on it. to_timestamp / extract(epoch) / floor exist on all of
// them (extract returns double on PG13, numeric on PG14+; floor/division handle both identically),
// and buckets align to the Unix epoch so their boundaries are stable across calls.
export function getQueueStatsHistoryBucketed (schema: string, aggregate: 'max' | 'min' | 'avg', mode: 'bucket' | 'auto'): string {
  const agg = STATS_AGG[aggregate]

  const widthCte = mode === 'auto'
    ? `WITH extent AS (
         SELECT min(captured_on) AS lo, max(captured_on) AS hi
         FROM ${schema}.queue_stats
         WHERE name = $1
       ),
       bounds AS (
         SELECT
           greatest(coalesce($2::timestamptz, lo), lo) AS lo,
           least(coalesce($3::timestamptz, hi), hi)    AS hi
         FROM extent
       ),
       w AS (
         SELECT greatest(1, ceil(extract(epoch from (hi - lo)) / greatest($5, 1))::bigint)::bigint AS secs
         FROM bounds
       )`
    : 'WITH w AS (SELECT greatest($5, 1)::bigint AS secs)'

  // Hard-cap auto-mode at maxDataPoints. Epoch-aligned bucketing can straddle a boundary and emit
  // one bucket more than the target, so cap the row count at the smaller of the user's limit and
  // maxDataPoints. ORDER BY DESC means the cap drops the oldest (straddle) bucket and keeps the
  // newest N. Explicit bucketSeconds has no target to overshoot, so it keeps the raw limit.
  const limit = mode === 'auto' ? 'least($4, $5)' : '$4'

  return `
    ${widthCte}
    SELECT
      to_timestamp(floor(extract(epoch from captured_on) / w.secs) * w.secs) as "capturedOn",
      ${agg('deferred_count')} as "deferredCount",
      ${agg('queued_count')}   as "queuedCount",
      ${agg('ready_count')}    as "readyCount",
      ${agg('active_count')}   as "activeCount",
      ${agg('failed_count')}   as "failedCount",
      ${agg('total_count')}    as "totalCount"
    FROM ${schema}.queue_stats, w
    WHERE name = $1
      AND ($2::timestamptz IS NULL OR captured_on >= $2)
      AND ($3::timestamptz IS NULL OR captured_on <= $3)
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT ${limit}
  `
}

export function getVersion (schema: string) {
  return `SELECT version from ${schema}.version`
}

export function setVersion (schema: string, version: number) {
  return `UPDATE ${schema}.version SET version = '${version}'`
}

export function versionTableExists (schema: string) {
  return `SELECT to_regclass('${schema}.version') as name`
}

export function getPartitionedQueueTables (schema: string) {
  return `SELECT table_name FROM ${schema}.queue WHERE partition = true`
}

export function insertVersion (schema: string, version: number) {
  return `INSERT INTO ${schema}.version(version) VALUES ('${version}')`
}

interface GroupConcurrencyConfig {
  default: number
  tiers?: Record<string, number>
}

interface FetchJobOptions {
  schema: string
  table: string
  name: string
  policy: string | undefined
  limit: number
  includeMetadata?: boolean
  priority?: boolean
  orderByCreatedOn?: boolean
  ignoreStartAfter?: boolean
  ignoreSingletons: string[] | null
  ignoreGroups?: string[] | null
  groupConcurrency?: number | GroupConcurrencyConfig
  minPriority?: number
  maxPriority?: number
}

interface FetchQueryParams {
  values: unknown[]
  ignoreSingletonsParam: string
  ignoreGroupsParam: string
  defaultGroupLimitParam: string
  tiersParam: string
  minPriorityParam: string
  maxPriorityParam: string
}

function buildFetchParams (options: FetchJobOptions): FetchQueryParams {
  const { ignoreSingletons, ignoreGroups, groupConcurrency, minPriority, maxPriority } = options
  const hasIgnoreSingletons = ignoreSingletons != null && ignoreSingletons.length > 0
  const hasIgnoreGroups = ignoreGroups != null && ignoreGroups.length > 0
  const hasGroupConcurrency = groupConcurrency != null
  const hasMinPriority = minPriority != null
  const hasMaxPriority = maxPriority != null
  const groupConcurrencyConfig = hasGroupConcurrency
    ? (typeof groupConcurrency === 'number' ? { default: groupConcurrency } : groupConcurrency)
    : null
  const hasTiers = groupConcurrencyConfig?.tiers && Object.keys(groupConcurrencyConfig.tiers).length > 0

  const values: unknown[] = []
  let paramIndex = 0
  let ignoreSingletonsParam = ''
  let ignoreGroupsParam = ''
  let defaultGroupLimitParam = ''
  let tiersParam = ''
  let minPriorityParam = ''
  let maxPriorityParam = ''

  if (hasIgnoreSingletons) {
    paramIndex++
    ignoreSingletonsParam = `$${paramIndex}::text[]`
    values.push(ignoreSingletons)
  }

  if (hasIgnoreGroups) {
    paramIndex++
    ignoreGroupsParam = `$${paramIndex}::text[]`
    values.push(ignoreGroups)
  }

  if (hasGroupConcurrency && groupConcurrencyConfig) {
    paramIndex++
    defaultGroupLimitParam = `$${paramIndex}::int`
    values.push(groupConcurrencyConfig.default)

    if (hasTiers) {
      paramIndex++
      tiersParam = `$${paramIndex}::jsonb`
      values.push(JSON.stringify(groupConcurrencyConfig.tiers))
    }
  }

  if (hasMinPriority) {
    paramIndex++
    minPriorityParam = `$${paramIndex}::int`
    values.push(minPriority)
  }

  if (hasMaxPriority) {
    paramIndex++
    maxPriorityParam = `$${paramIndex}::int`
    values.push(maxPriority)
  }

  return { values, ignoreSingletonsParam, ignoreGroupsParam, defaultGroupLimitParam, tiersParam, minPriorityParam, maxPriorityParam }
}

/**
 * Builds the fetch query for claiming jobs from the queue.
 *
 * With SKIP LOCKED (noSkipLocked=false, the default), uses SELECT FOR UPDATE SKIP
 * LOCKED, which lets multiple workers efficiently fetch different jobs simultaneously.
 *
 * With noSkipLocked=true, omits FOR UPDATE SKIP LOCKED and adds an additional state
 * check in the WHERE clause. This pattern works better with distributed databases like
 * CockroachDB where SKIP LOCKED has performance issues and can unexpectedly skip
 * unlocked rows.
 *
 * Trade-off when noSkipLocked is set: under high contention, workers may receive fewer
 * jobs per fetch as concurrent updates to the same rows will result in some workers
 * getting empty results. This is acceptable for job queues where processing time
 * exceeds fetch time.
 */
export function fetchNextJob (options: FetchJobOptions, noSkipLocked = false): SqlQuery {
  const { schema, table, name, policy, limit, includeMetadata, priority = true, orderByCreatedOn = true, ignoreStartAfter = false, groupConcurrency, minPriority, maxPriority } = options

  const singletonFetch = limit > 1 && (policy === QUEUE_POLICIES.singleton || policy === QUEUE_POLICIES.stately)
  const hasIgnoreSingletons = options.ignoreSingletons != null && options.ignoreSingletons.length > 0
  const hasIgnoreGroups = options.ignoreGroups != null && options.ignoreGroups.length > 0
  const hasGroupConcurrency = groupConcurrency != null
  const hasMinPriority = minPriority != null
  const hasMaxPriority = maxPriority != null
  const hasTiers = hasGroupConcurrency &&
    typeof groupConcurrency === 'object' &&
    groupConcurrency.tiers &&
    Object.keys(groupConcurrency.tiers).length > 0

  const params = buildFetchParams(options)

  const selectCols = [
    'j.id',
    singletonFetch ? 'j.singleton_key' : '',
    hasGroupConcurrency ? 'j.group_id, j.group_tier' : ''
  ].filter(Boolean).join(', ')

  // MATERIALIZED forces Postgres to compute this aggregation once and cache the
  // result. Without it, Postgres 12+ may inline the CTE and re-evaluate the
  // COUNT query at each reference site. active_group_counts is referenced twice:
  // once in the next CTE join (to pre-filter saturated groups before LIMIT) and
  // once in group_ranking (to enforce the per-batch concurrency limit).
  const activeGroupCountsCte = hasGroupConcurrency
    ? `active_group_counts AS MATERIALIZED (
        SELECT group_id, COUNT(*)::int as active_cnt
        FROM ${schema}.${table}
        WHERE name = '${name}' AND state = '${JOB_STATES.active}' AND group_id IS NOT NULL
        GROUP BY group_id
      ), `
    : ''

  // With noSkipLocked, omit FOR UPDATE SKIP LOCKED as it performs poorly
  // in distributed databases like CockroachDB
  const lockClause = noSkipLocked ? '' : 'FOR UPDATE OF j SKIP LOCKED'

  // Column references are qualified with j. throughout so both the base case and
  // the groupConcurrency branch (which joins active_group_counts) share one set of
  // expressions. The join introduces agc.group_id which would otherwise be ambiguous.
  const whereConditions = [
    `j.name = '${name}'`,
    `j.state < '${JOB_STATES.active}'`,
    'NOT j.blocked',
    !ignoreStartAfter ? 'j.start_after < now()' : '',
    hasIgnoreSingletons ? `j.singleton_key <> ALL(${params.ignoreSingletonsParam})` : '',
    hasIgnoreGroups ? `(j.group_id IS NULL OR j.group_id <> ALL(${params.ignoreGroupsParam}))` : '',
    hasMinPriority ? `j.priority >= ${params.minPriorityParam}` : '',
    hasMaxPriority ? `j.priority <= ${params.maxPriorityParam}` : '',
    hasGroupConcurrency
      ? `(j.group_id IS NULL
            OR agc.active_cnt IS NULL
            OR agc.active_cnt < ${hasTiers
              ? `COALESCE((${params.tiersParam} ->> j.group_tier)::int, ${params.defaultGroupLimitParam})`
              : params.defaultGroupLimitParam})`
      : ''
  ].filter(Boolean).join('\n          AND ')

  const nextCte = `
      next AS (
        SELECT ${selectCols}
        FROM ${schema}.${table} j
        ${hasGroupConcurrency ? 'LEFT JOIN active_group_counts agc ON j.group_id = agc.group_id' : ''}
        WHERE ${whereConditions}
        ORDER BY ${priority ? 'j.priority desc, ' : ''}${orderByCreatedOn ? 'j.created_on, ' : ''}j.id
        LIMIT ${limit}
        ${lockClause}
      )`

  const singletonCte = singletonFetch
    ? `, singleton_ranking AS (
        SELECT id, ${hasGroupConcurrency ? 'group_id, group_tier, ' : ''}
          row_number() OVER (PARTITION BY singleton_key) as singleton_rn
        FROM next
      )`
    : ''

  const groupConcurrencyCtes = hasGroupConcurrency
    ? `,
      group_ranking AS (
        SELECT t.id
          , t.group_id
          , t.group_tier
          ${singletonFetch ? ', singleton_rn' : ''}
          , ROW_NUMBER() OVER (PARTITION BY t.group_id ORDER BY t.id) as group_rn
          , COALESCE(agc.active_cnt, 0) as active_cnt
        FROM ${singletonFetch ? 'singleton_ranking' : 'next'} t
        LEFT JOIN active_group_counts agc ON t.group_id = agc.group_id
        ${singletonFetch ? 'WHERE singleton_rn = 1' : ''}
      ),
      group_filtered AS (
        SELECT id FROM group_ranking
        WHERE group_id IS NULL
          OR (active_cnt + group_rn) <= ${hasTiers
          ? `COALESCE((${params.tiersParam} ->> group_tier)::int, ${params.defaultGroupLimitParam})`
          : params.defaultGroupLimitParam}
      )`
    : ''

  const finalCte = (hasGroupConcurrency)
    ? 'group_filtered'
    : (singletonFetch)
        ? 'singleton_ranking'
        : 'next'

  // Without SKIP LOCKED, add a state check to prevent duplicate processing
  // when multiple workers try to claim the same jobs concurrently
  const distributedStateCheck = noSkipLocked ? `AND j.state < '${JOB_STATES.active}'` : ''

  return {
    text: `
      WITH
      ${activeGroupCountsCte}
      ${nextCte}
      ${singletonCte}
      ${groupConcurrencyCtes}
      UPDATE ${schema}.${table} j SET
        state = '${JOB_STATES.active}',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM ${finalCte}
      WHERE name = '${name}' AND j.id = ${finalCte}.id
      ${singletonFetch && !hasGroupConcurrency ? 'AND singleton_rn = 1' : ''}
      ${distributedStateCheck}
      RETURNING j.${includeMetadata ? JOB_COLUMNS_ALL : JOB_COLUMNS_MIN}
    `,
    values: params.values
  }
}

// Shared SET/WHERE body for marking jobs completed (no RETURNING). Used by the
// single-statement completeJobs() and the distributed completeJobsDistributed().
function completeJobsUpdate (schema: string, table: string, includeQueued?: boolean): string {
  return `UPDATE ${schema}.${table}
      SET completed_on = now(),
        state = '${JOB_STATES.completed}',
        output = $3::jsonb,
        blocked = ${includeQueued ? 'false' : 'blocked'},
        pending_dependencies = ${includeQueued ? '0' : 'pending_dependencies'}
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND ${includeQueued
          ? `state < '${JOB_STATES.completed}'`
          : `state = '${JOB_STATES.active}'`
        }`
}

// Shared dependency-unblocking fragments. Both consume a `decremented` CTE
// (child_name, child_id, n) that the caller defines, and are reused by the standard
// completeJobs() and the distributed decrementDependents().
function lockedChildrenCte (schema: string): string {
  return `locked_children AS (
      SELECT j.name, j.id, d.n
      FROM ${schema}.job j
      JOIN decremented d ON d.child_name = j.name
        AND d.child_id = j.id
      WHERE j.blocked
      ORDER BY j.name, j.id
      FOR UPDATE OF j
    )`
}

function unblockChildrenUpdate (schema: string): string {
  return `UPDATE ${schema}.job j
      SET pending_dependencies = GREATEST(j.pending_dependencies - lc.n, 0),
          blocked = GREATEST(j.pending_dependencies - lc.n, 0) > 0
      FROM locked_children lc
      WHERE j.name = lc.name
        AND j.id = lc.id`
}

// Dependency unblocking is intentionally NOT done here. Completion is the hot path; chasing
// dependents inline (joining job_dependency and the partitioned job table) made completion
// scale with partition count (see issue #824). The background resolver (Navigator) handles
// unblocking out of band, driven by the job_i9 partial index.
export function completeJobs (schema: string, table: string, includeQueued?: boolean) {
  return `
    WITH results AS (
      ${completeJobsUpdate(schema, table, includeQueued)}
      RETURNING 1
    )
    SELECT COUNT(*) FROM results
  `
}

// Per-job-output completion: each job's output is supplied via a JSON recordset ($2) and applied by
// id, so a batch can be completed with distinct outputs in a single statement. Mirrors completeJobs
// (only active jobs; same dependency-unblocking), but sources output from the input join.
export function completeJobsWithOutputs (schema: string, table: string) {
  return `
    WITH input AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    ),
    results AS (
      UPDATE ${schema}.${table} j
      SET completed_on = now(),
        state = '${JOB_STATES.completed}',
        output = i.output
      FROM input i
      WHERE j.name = $1
        AND j.id = i.id
        AND j.state = '${JOB_STATES.active}'
      RETURNING 1
    )
    SELECT COUNT(*) FROM results
  `
}

// Distributed equivalent of completeJobsWithOutputs: a single mutation that returns the completed
// ids. Dependency unblocking is handled out of band by the background resolver (Navigator), so
// completion does no dependency work on any backend.
export function completeJobsWithOutputsDistributed (schema: string, table: string) {
  return `
    WITH input AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    )
    UPDATE ${schema}.${table} j
    SET completed_on = now(),
      state = '${JOB_STATES.completed}',
      output = i.output
    FROM input i
    WHERE j.name = $1
      AND j.id = i.id
      AND j.state = '${JOB_STATES.active}'
    RETURNING j.id
  `
}

export function cancelJobs (schema: string, table: string) {
  return `
    WITH results as (
      UPDATE ${schema}.${table}
      SET completed_on = now(),
        state = '${JOB_STATES.cancelled}'
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state < '${JOB_STATES.completed}'
      RETURNING 1
    )
    SELECT COUNT(*) from results
  `
}

export function resumeJobs (schema: string, table: string) {
  return `
    WITH results as (
      UPDATE ${schema}.${table}
      SET completed_on = NULL,
        state = '${JOB_STATES.created}'
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state = '${JOB_STATES.cancelled}'
      RETURNING 1
    )
    SELECT COUNT(*) from results
  `
}

export function restoreJobs (schema: string, table: string) {
  return `
    UPDATE ${schema}.${table}
    SET state = '${JOB_STATES.created}',
        started_on = NULL,
        heartbeat_on = NULL
    WHERE name = $1
      AND id = ANY($2::uuid[])
  `
}

interface InsertJobsOptions {
  table: string
  name: string
  returnId?: boolean
  notify?: boolean
}

export function insertJobs (schema: string, { table, name, returnId = true, notify = false }: InsertJobsOptions) {
  // When notify is enabled we always RETURN start_after so the wrapper below can gate
  // the NOTIFY on immediate availability, regardless of whether the caller wants ids.
  const returning = notify ? 'RETURNING id, start_after' : returnId ? 'RETURNING id' : ''

  const insert = `
    INSERT INTO ${schema}.${table} (
      id,
      name,
      data,
      priority,
      start_after,
      singleton_key,
      singleton_on,
      group_id,
      group_tier,
      expire_seconds,
      deletion_seconds,
      keep_until,
      retry_limit,
      retry_delay,
      retry_backoff,
      retry_delay_max,
      policy,
      dead_letter,
      heartbeat_seconds,
      blocked,
      blocking,
      pending_dependencies
    )
    SELECT
      COALESCE(id, gen_random_uuid()) as id,
      '${name}' as name,
      data,
      COALESCE(priority, 0) as priority,
      j.start_after,
      "singletonKey",
      CASE
        WHEN "singletonSeconds" IS NOT NULL THEN 'epoch'::timestamp + '1s'::interval * ("singletonSeconds"::float8 * floor(( date_part('epoch', now()) + COALESCE("singletonOffset",0)::float8) / "singletonSeconds"::float8 ))
        ELSE NULL
        END as singleton_on,
      "groupId" as group_id,
      "groupTier" as group_tier,
      COALESCE("expireInSeconds", q.expire_seconds) as expire_seconds,
      COALESCE("deleteAfterSeconds", q.deletion_seconds) as deletion_seconds,
      j.start_after + (COALESCE("retentionSeconds", q.retention_seconds) * interval '1s') as keep_until,
      COALESCE("retryLimit", q.retry_limit) as retry_limit,
      COALESCE("retryDelay", q.retry_delay) as retry_delay,
      COALESCE("retryBackoff", q.retry_backoff, false) as retry_backoff,
      COALESCE("retryDelayMax", q.retry_delay_max) as retry_delay_max,
      q.policy,
      COALESCE("deadLetter", q.dead_letter) as dead_letter,
      COALESCE("heartbeatSeconds", q.heartbeat_seconds) as heartbeat_seconds,
      COALESCE(blocked, false) as blocked,
      COALESCE(blocking, false) as blocking,
      COALESCE("pendingDependencies", 0) as pending_dependencies
    FROM (
      SELECT *,
        CASE
          WHEN right("startAfter", 1) = 'Z' THEN CAST("startAfter" as timestamp with time zone)
          ELSE now() + CAST(COALESCE("startAfter",'0') as interval)
          END as start_after
      FROM json_to_recordset($1::json) as x (
        id uuid,
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
        "groupId" text,
        "groupTier" text,
        "expireInSeconds" integer,
        "deleteAfterSeconds" integer,
        "retentionSeconds" integer,
        "deadLetter" text,
        "heartbeatSeconds" integer,
        blocked boolean,
        blocking boolean,
        "pendingDependencies" integer
      )
    ) j
    JOIN ${schema}.queue q ON q.name = '${name}'
    ON CONFLICT DO NOTHING
    ${returning}
  `

  if (!notify) {
    return insert
  }

  // Fire a single transactional NOTIFY (committed atomically with the insert) only when
  // at least one inserted row is immediately runnable. Future-dated/throttled jobs are
  // left to the polling floor. The `notified` CTE is referenced from the final WHERE so
  // Postgres actually evaluates it; pg_notify runs at most once thanks to LIMIT 1. The
  // comparator shapes the output rows to honor returnId without changing notify behavior.
  const comparator = returnId ? '>= 0' : '< 0'

  return `
    WITH ins AS (
      ${insert}
    ),
    notified AS (
      SELECT pg_notify(${notifyChannelSql(schema)}, '${name}')
      FROM ins WHERE start_after <= now() LIMIT 1
    )
    SELECT id FROM ins WHERE (SELECT count(*) FROM notified) ${comparator}
  `
}

// Self-contained (parameter-less) insert for one queue's slice of a flow batch. The JSON
// payload is embedded directly so the whole flow can be sent as a single multi-statement
// round-trip regardless of db adapter. Guarded so a skipped row (ON CONFLICT) raises
// 'division by zero', aborting the surrounding transaction. The divisor references the
// row count so it isn't constant-folded at plan time.
export function insertFlowJobs (schema: string, { table, name }: { table: string, name: string }, jobs: unknown[]): string {
  const insert = insertJobs(schema, { table, name, returnId: true })
    .replace('$1', () => serializeJsonParam(jobs))

  return `
    WITH ins AS (
      ${insert}
    )
    SELECT 1 / (CASE WHEN (SELECT count(*) FROM ins) = ${jobs.length} THEN 1 ELSE 0 END)
  `
}

export function failJobsById (schema: string, table: string) {
  const where = `name = $1 AND id = ANY($2::uuid[]) AND state < '${JOB_STATES.completed}'`
  const output = '$3::jsonb'

  return failJobs(schema, table, where, output)
}

export function failJobsByTimeout (schema: string, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const where = `state = '${JOB_STATES.active}'
            AND (started_on + expire_seconds * interval '1s') < now()
            AND name = ANY(${serializeArrayParam(queues)})`

  const output = '\'{ "value": { "message": "job timed out" } }\'::jsonb'

  return locked(schema, failJobs(schema, table, where, output), table + 'failJobsByTimeout', noAdvisoryLocks)
}

export function failJobsByHeartbeat (schema: string, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const where = `state = '${JOB_STATES.active}'
            AND heartbeat_seconds IS NOT NULL
            AND (heartbeat_on + heartbeat_seconds * interval '1s') < now()
            AND name = ANY(${serializeArrayParam(queues)})`

  const output = '\'{ "value": { "message": "job heartbeat timeout" } }\'::jsonb'

  return locked(schema, failJobs(schema, table, where, output), table + 'failJobsByHeartbeat', noAdvisoryLocks)
}

export function touchJobs (schema: string, table: string) {
  return `
    WITH results AS (
      UPDATE ${schema}.${table}
      SET heartbeat_on = now()
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state = '${JOB_STATES.active}'
      RETURNING 1
    )
    SELECT COUNT(*) FROM results
  `
}

function failJobs (schema: string, table: string, where: string, output: string) {
  return `
    WITH ${failJobsBody(schema, table, where, output)}
    SELECT COUNT(*) FROM results
  `
}

// The CTE chain shared by failJobs() and failJobsByIdWithOutputs(): delete the matched jobs and
// re-insert them as retry (when retries remain) or failed (+ dead letter). `where` selects the rows
// to fail and `output` is the SQL expression stored on each re-inserted job. Returned without the
// leading `WITH` or trailing `SELECT` so callers can prepend extra CTEs (e.g. an output map).
// When `forceTerminal` is set, every re-inserted job goes straight to the terminal `failed` state
// regardless of remaining retries, so the dlq_jobs CTE routes it to the dead letter queue (if any)
// immediately. This backs the perJobResults `deadletter` disposition.
function failJobsBody (schema: string, table: string, where: string, output: string, forceTerminal = false) {
  const state = forceTerminal
    ? `'${JOB_STATES.failed}'::${schema}.job_state`
    : `CASE
          WHEN retry_count < retry_limit THEN '${JOB_STATES.retry}'::${schema}.job_state
          ELSE '${JOB_STATES.failed}'::${schema}.job_state
          END`
  const completedOn = forceTerminal
    ? 'now()'
    : 'CASE WHEN retry_count < retry_limit THEN NULL ELSE now() END'

  return `deleted_jobs AS (
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
        group_id,
        group_tier,
        expire_seconds,
        deletion_seconds,
        created_on,
        completed_on,
        keep_until,
        policy,
        output,
        dead_letter,
        heartbeat_on,
        heartbeat_seconds,
        blocked,
        blocking,
        pending_dependencies
      )
      SELECT
        id,
        name,
        priority,
        data,
        ${state} as state,
        retry_limit,
        retry_count,
        retry_delay,
        retry_backoff,
        retry_delay_max,
        CASE WHEN retry_count = retry_limit THEN start_after
             WHEN NOT retry_backoff THEN now() + retry_delay * interval '1'
             ELSE now() + LEAST(
               retry_delay_max,
               retry_delay * (
                2 ^ LEAST(16, retry_count + 1) / 2 +
                2 ^ LEAST(16, retry_count + 1) / 2 * random()
               )
             ) * interval '1s'
        END as start_after,
        started_on,
        singleton_key,
        singleton_on,
        group_id,
        group_tier,
        expire_seconds,
        deletion_seconds,
        created_on,
        ${completedOn} as completed_on,
        keep_until,
        policy,
        ${output},
        dead_letter,
        NULL as heartbeat_on,
        heartbeat_seconds,
        blocked,
        blocking,
        pending_dependencies
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
        group_id,
        group_tier,
        expire_seconds,
        deletion_seconds,
        created_on,
        completed_on,
        keep_until,
        policy,
        output,
        dead_letter,
        heartbeat_on,
        heartbeat_seconds,
        blocked,
        blocking,
        pending_dependencies
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
        group_id,
        group_tier,
        expire_seconds,
        deletion_seconds,
        created_on,
        now() as completed_on,
        keep_until,
        policy,
        ${output},
        dead_letter,
        NULL as heartbeat_on,
        heartbeat_seconds,
        blocked,
        blocking,
        pending_dependencies
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
      INSERT INTO ${schema}.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
        source_name, source_id, source_created_on, source_retry_count)
      SELECT
        r.dead_letter,
        r.data,
        r.output,
        q.retry_limit,
        q.retry_backoff,
        q.retry_delay,
        now() + q.retention_seconds * interval '1s',
        q.deletion_seconds,
        r.name,
        r.id,
        r.created_on,
        r.retry_count
      FROM results r
        JOIN ${schema}.queue q ON q.name = r.dead_letter
      WHERE state = '${JOB_STATES.failed}'
    )`
}

export function failJobsByIdWithOutputs (schema: string, table: string) {
  // Output is supplied per job via a JSON recordset ($2). `where` and the output expression both
  // reference the output_map CTE so each re-inserted job keeps its own output. Constant number of
  // statements regardless of batch size.
  const where = `name = $1 AND id IN (SELECT id FROM output_map) AND state < '${JOB_STATES.completed}'`
  const output = '(SELECT om.output FROM output_map om WHERE om.id = deleted_jobs.id)'

  return `
    WITH output_map AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    ),
    ${failJobsBody(schema, table, where, output)}
    SELECT COUNT(*) FROM results
  `
}

// Like failJobsByIdWithOutputs, but fails every job terminally (forceTerminal) so it routes straight
// to the dead letter queue, bypassing remaining retries. Backs the perJobResults `deadletter` status.
export function deadLetterJobsByIdWithOutputs (schema: string, table: string) {
  const where = `name = $1 AND id IN (SELECT id FROM output_map) AND state < '${JOB_STATES.completed}'`
  const output = '(SELECT om.output FROM output_map om WHERE om.id = deleted_jobs.id)'

  return `
    WITH output_map AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    ),
    ${failJobsBody(schema, table, where, output, true)}
    SELECT COUNT(*) FROM results
  `
}

// Distributed mode: separate queries to avoid CockroachDB's multi-mutation CTE limitation
export function selectJobsToFailById (schema: string, table: string): SqlQuery {
  return {
    text: `SELECT * FROM ${schema}.${table} WHERE name = $1 AND id = ANY($2::uuid[]) AND state < '${JOB_STATES.completed}'`,
    values: []
  }
}

export function deleteJobsToFail (schema: string, table: string): SqlQuery {
  return {
    text: `DELETE FROM ${schema}.${table} WHERE name = $1 AND id = ANY($2::uuid[])`,
    values: []
  }
}

// Distributed mode: the predicate-based maintenance expiry equivalents of selectJobsToFailById.
// The supervisor's failJobsByTimeout/failJobsByHeartbeat use the multi-mutation failJobs() CTE,
// which CockroachDB rejects, so in distributed mode we select the timed-out jobs here and re-insert
// them separately (delete via deleteJobsByIds, re-insert via insertRetryJob), all in one transaction.
export function selectJobsToFailByTimeout (schema: string, table: string, queues: string[]): SqlQuery {
  return {
    text: `SELECT * FROM ${schema}.${table}
      WHERE state = '${JOB_STATES.active}'
        AND (started_on + expire_seconds * interval '1s') < now()
        AND name = ANY(${serializeArrayParam(queues)})`,
    values: []
  }
}

export function selectJobsToFailByHeartbeat (schema: string, table: string, queues: string[]): SqlQuery {
  return {
    text: `SELECT * FROM ${schema}.${table}
      WHERE state = '${JOB_STATES.active}'
        AND heartbeat_seconds IS NOT NULL
        AND (heartbeat_on + heartbeat_seconds * interval '1s') < now()
        AND name = ANY(${serializeArrayParam(queues)})`,
    values: []
  }
}

export function deleteJobsByIds (schema: string, table: string): SqlQuery {
  return {
    text: `DELETE FROM ${schema}.${table} WHERE id = ANY($1::uuid[])`,
    values: []
  }
}

// Distributed mode: complete jobs as a single-table mutation. Dependency unblocking is handled
// out of band by the background resolver (Navigator), so completion does no dependency work.
export function completeJobsDistributed (schema: string, table: string, includeQueued?: boolean): string {
  return `
    ${completeJobsUpdate(schema, table, includeQueued)}
    RETURNING id
  `
}

// Decrement pending_dependencies for children of the given completed parent jobs, unblocking
// any that reach zero. Only the final UPDATE mutates job, so this is a single mutation acceptable
// to CockroachDB. Used by the distributed flow resolver path. $1 is the parent queue name, $2 the
// list of resolved parent ids for that queue.
export function decrementDependents (schema: string): string {
  return `
    WITH decremented AS (
      SELECT d.child_name, d.child_id, COUNT(*)::int AS n
      FROM ${schema}.job_dependency d
      WHERE d.parent_name = $1
        AND d.parent_id = ANY($2::uuid[])
      GROUP BY d.child_name, d.child_id
    ),
    ${lockedChildrenCte(schema)}
    ${unblockChildrenUpdate(schema)}
  `
}

// Background flow resolver (Navigator) batch size: the max number of completed blocking parents
// locked per audit statement. The resolver loops until a batch drains, so this only bounds the
// lock footprint and per-statement cost.
export const FLOW_BATCH_SIZE = 1000

// Standard (multi-mutation CTE) flow audit. Locks a batch of completed blocking parents in the
// given partition table, decrements their children's pending_dependencies (reusing the shared
// unblock fragments, which reach across partitions via the parent job table), unblocks children
// that reach zero, and clears `blocking` on the resolved parents so they leave the job_i9 index
// and are never reprocessed. $1 is the chunk of queue names (for partition pruning). Returns the
// number of parents resolved so the caller can loop until a batch drains.
export function resolveFlowJobs (schema: string, table: string, names: string[]): SqlQuery {
  return {
    text: `
    WITH locked_parents AS (
      SELECT j.name, j.id
      FROM ${schema}.${table} j
      WHERE j.blocking
        AND j.state = '${JOB_STATES.completed}'
        AND j.name = ANY($1::text[])
      ORDER BY j.name, j.id
      FOR UPDATE OF j SKIP LOCKED
      LIMIT ${FLOW_BATCH_SIZE}
    ),
    decremented AS (
      SELECT d.child_name, d.child_id, COUNT(*)::int AS n
      FROM ${schema}.job_dependency d
      JOIN locked_parents p ON d.parent_name = p.name
        AND d.parent_id = p.id
      GROUP BY d.child_name, d.child_id
    ),
    ${lockedChildrenCte(schema)},
    unblocked AS (
      ${unblockChildrenUpdate(schema)}
      RETURNING 1
    ),
    cleared AS (
      UPDATE ${schema}.${table} j
      SET blocking = false
      FROM locked_parents p
      WHERE j.name = p.name
        AND j.id = p.id
      RETURNING 1
    )
    SELECT COUNT(*)::int AS resolved FROM cleared
  `,
    values: [names]
  }
}

// Distributed flow audit (CockroachDB / noMultiMutationCte). Locks a batch of completed blocking
// parents without mutating, so the caller can run the single-mutation decrementDependents() and
// clearBlocking() separately within one transaction. $1 is the chunk of queue names; SKIP LOCKED
// is omitted under noSkipLocked.
export function selectBlockingParents (schema: string, table: string, names: string[], noSkipLocked?: boolean): SqlQuery {
  return {
    text: `
      SELECT name, id
      FROM ${schema}.${table}
      WHERE blocking
        AND state = '${JOB_STATES.completed}'
        AND name = ANY($1::text[])
      ORDER BY name, id
      FOR UPDATE${noSkipLocked ? '' : ' SKIP LOCKED'}
      LIMIT ${FLOW_BATCH_SIZE}
    `,
    values: [names]
  }
}

// Distributed flow audit: clear `blocking` on resolved parents (single mutation). $1 is the parent
// queue name, $2 the list of resolved parent ids for that queue.
export function clearBlocking (schema: string): string {
  return `
    UPDATE ${schema}.job
    SET blocking = false
    WHERE name = $1
      AND id = ANY($2::uuid[])
  `
}

export function insertRetryJob (schema: string, table: string): string {
  return `
    INSERT INTO ${schema}.${table} (
      id, name, priority, data, state, retry_limit, retry_count, retry_delay,
      retry_backoff, retry_delay_max, start_after, started_on, singleton_key, singleton_on,
      group_id, group_tier, expire_seconds, deletion_seconds, created_on, completed_on,
      keep_until, policy, output, dead_letter,
      heartbeat_on, heartbeat_seconds, blocked, blocking, pending_dependencies
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
      $25, $26, $27, $28, $29
    ) ON CONFLICT DO NOTHING
    RETURNING id
  `
}

export function insertDeadLetterJob (schema: string): string {
  return `
    INSERT INTO ${schema}.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
      source_name, source_id, source_created_on, source_retry_count)
    SELECT $1, $2, $3, q.retry_limit, q.retry_backoff, q.retry_delay, now() + q.retention_seconds * interval '1s', q.deletion_seconds,
      $4, $5, $6, $7
    FROM ${schema}.queue q WHERE q.name = $1
  `
}

// Dead-letter redrive. Moves un-started jobs out of a dead-letter queue and
// re-creates them as fresh jobs on their original source queue (or $2 destination override),
// oldest-first, capped at $4. The JOIN in `candidates` only matches jobs whose destination queue
// exists, so legacy/orphaned jobs (NULL source_name, no override) are never deleted — they stay
// in the DLQ rather than being lost. Re-created jobs get a new id, `created` state, retry_count 0,
// cleared output, NULL source_*, and the destination queue's current retry/retention/policy config.
export function redriveJobs (schema: string, table: string): string {
  return `
    WITH candidates AS (
      SELECT j.id
      FROM ${schema}.${table} j
      JOIN ${schema}.queue q ON q.name = COALESCE($2, j.source_name)
      WHERE j.name = $1
        AND j.state < '${JOB_STATES.active}'
        AND ($3::text IS NULL OR j.source_name = $3)
      ORDER BY j.created_on
      LIMIT $4
      FOR UPDATE OF j SKIP LOCKED
    ),
    moved AS (
      DELETE FROM ${schema}.${table}
      WHERE id IN (SELECT id FROM candidates)
      RETURNING *
    ),
    ins AS (
      INSERT INTO ${schema}.job
        (name, data, priority, retry_limit, retry_backoff, retry_delay, retry_delay_max,
         expire_seconds, keep_until, deletion_seconds, policy)
      SELECT COALESCE($2, m.source_name), m.data, m.priority, q.retry_limit, q.retry_backoff,
        q.retry_delay, q.retry_delay_max, q.expire_seconds,
        now() + q.retention_seconds * interval '1s', q.deletion_seconds, q.policy
      FROM moved m JOIN ${schema}.queue q ON q.name = COALESCE($2, m.source_name)
      RETURNING 1
    )
    SELECT count(*)::int AS moved FROM ins
  `
}

export function deletion (schema: string, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const sql = `
    DELETE FROM ${schema}.${table}
    WHERE name = ANY(${serializeArrayParam(queues)})
      AND
      (
        (deletion_seconds > 0 AND completed_on + deletion_seconds * interval '1s' < now())
        OR
        (state < '${JOB_STATES.active}' AND keep_until < now())
      )
  `

  return locked(schema, sql, table + 'deletion', noAdvisoryLocks)
}

export function retryJobs (schema: string, table: string) {
  return `
    WITH results as (
      UPDATE ${schema}.job
      SET state = '${JOB_STATES.retry}',
        retry_limit = retry_limit + 1
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state = '${JOB_STATES.failed}'
      RETURNING 1
    )
    SELECT COUNT(*) from results
  `
}

export function getQueueStats (schema: string, table: string, queues: string[]): SqlQuery {
  return {
    text: `
    SELECT
        name,
        "deferredCount",
        "queuedCount",
        GREATEST("queuedCount" - "deferredCount", 0) as "readyCount",
        "activeCount",
        "failedCount",
        "totalCount",
        "singletonsActive"
      FROM (
        SELECT
            name,
            (count(*) FILTER (WHERE start_after > now()))::int as "deferredCount",
            (count(*) FILTER (WHERE state < '${JOB_STATES.active}'))::int as "queuedCount",
            (count(*) FILTER (WHERE state = '${JOB_STATES.active}'))::int as "activeCount",
            (count(*) FILTER (WHERE state = '${JOB_STATES.failed}'))::int as "failedCount",
            count(*)::int as "totalCount",
            array_agg(singleton_key) FILTER (WHERE policy IN ('${QUEUE_POLICIES.singleton}','${QUEUE_POLICIES.stately}') AND state = '${JOB_STATES.active}') as "singletonsActive"
          FROM ${schema}.${table}
          WHERE name = ANY($1::text[])
          GROUP BY 1
      ) stats
  `,
    values: [queues]
  }
}

// Length of the recent-ready-count sliding window kept on queue.ready_history for the dashboard
// sparkline. One sample is appended per monitor cycle (default 60s), so this is roughly the last
// READY_HISTORY_SIZE minutes of trend. Sized to comfortably render the sparkline (the widest is the
// ~160px detail card) without over-collecting — more points than pixels add nothing visible.
export const READY_HISTORY_SIZE = 60

export function cacheQueueStats (schema: string, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const statsQuery = getQueueStats(schema, table, queues)
  // Serialize the $1 parameter for use in locked() multi-statement query
  const statsText = statsQuery.text.replace('$1::text[]', serializeArrayParam(queues))

  const sql = `
    WITH stats AS (${statsText})
    UPDATE ${schema}.queue SET
      deferred_count = COALESCE(stats."deferredCount", 0),
      queued_count = COALESCE(stats."queuedCount", 0),
      ready_count = COALESCE(stats."readyCount", 0),
      active_count = COALESCE(stats."activeCount", 0),
      failed_count = COALESCE(stats."failedCount", 0),
      total_count = COALESCE(stats."totalCount", 0),
      singletons_active = stats."singletonsActive",
      -- Always-on sliding window of recent ready counts for the dashboard sparkline (independent of
      -- persistQueueStats). Prepend the newest sample and keep the newest READY_HISTORY_SIZE, stored
      -- newest-first. Built with unnest + array_agg (not array slicing, which CockroachDB lacks).
      ready_history = (
        SELECT COALESCE(array_agg(v ORDER BY ord), '{}'::int[])
        FROM (
          SELECT v, ord
          FROM (
            SELECT COALESCE(stats."readyCount", 0)::int AS v, 0::bigint AS ord
            UNION ALL
            SELECT h.v, h.ord
            FROM unnest(COALESCE(queue.ready_history, '{}'::int[])) WITH ORDINALITY AS h(v, ord)
          ) merged
          ORDER BY ord
          LIMIT ${READY_HISTORY_SIZE}
        ) capped
      )
    FROM (
      SELECT q.name
      FROM unnest(${serializeArrayParam(queues)}) AS q(name)
    ) q
    LEFT JOIN stats ON stats.name = q.name
    WHERE queue.name = q.name
    RETURNING
      queue.name,
      queue.queued_count as "queuedCount",
      queue.warning_queued as "warningQueueSize"
  `

  return locked(schema, sql, 'queue-stats', noAdvisoryLocks)
}

// Recompute one queue's counts from the job table and write them back to the queue-table cache
// (including monitor_on, so subsequent reads are served from cache), returning the fresh counts.
// Backs getQueueStats(name, { force: true }) and the first read of a never-monitored queue. A single
// atomic UPDATE ... RETURNING — no advisory lock needed since concurrent forced refreshes are
// idempotent (each is a valid point-in-time snapshot; last write wins).
export function refreshQueueStats (schema: string, table: string, name: string): string {
  const statsQuery = getQueueStats(schema, table, [name])
  const statsText = statsQuery.text.replace('$1::text[]', serializeArrayParam([name]))

  return `
    WITH stats AS (${statsText})
    UPDATE ${schema}.queue SET
      deferred_count = COALESCE(stats."deferredCount", 0),
      queued_count = COALESCE(stats."queuedCount", 0),
      ready_count = COALESCE(stats."readyCount", 0),
      active_count = COALESCE(stats."activeCount", 0),
      failed_count = COALESCE(stats."failedCount", 0),
      total_count = COALESCE(stats."totalCount", 0),
      singletons_active = stats."singletonsActive",
      monitor_on = now()
    FROM (
      SELECT q.name
      FROM unnest(${serializeArrayParam([name])}) AS q(name)
    ) q
    LEFT JOIN stats ON stats.name = q.name
    WHERE queue.name = q.name
    RETURNING
      queue.name,
      queue.deferred_count as "deferredCount",
      queue.queued_count as "queuedCount",
      queue.ready_count as "readyCount",
      queue.active_count as "activeCount",
      queue.failed_count as "failedCount",
      queue.total_count as "totalCount",
      queue.monitor_on as "capturedOn"
  `
}

// Serialize a string array for embedding directly in SQL as PostgreSQL array literal
export function serializeArrayParam (values: string[]): string {
  const escaped = values.map(v => `'${v.replace(SINGLE_QUOTE_REGEX, "''")}'`)
  return `ARRAY[${escaped.join(',')}]::text[]`
}

// Serialize a JSON-serializable value for embedding directly in SQL as a quoted literal
export function serializeJsonParam (value: unknown): string {
  return `'${JSON.stringify(value).replace(SINGLE_QUOTE_REGEX, "''")}'`
}

export function transaction (query: string | string[]): string {
  const sql = Array.isArray(query) ? query.join(';\n') : query

  return `
    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    ${sql};
    COMMIT;
  `
}

export function locked (schema: string, query: string | string[], key?: string, noAdvisoryLocks?: boolean): string {
  const statements = Array.isArray(query) ? query : [query]
  return transaction(noAdvisoryLocks ? statements : [advisoryLock(schema, key), ...statements])
}

function advisoryLock (schema: string, key?: string) {
  return `SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.${schema}${key || ''}')::bytea), 'hex'))::bit(64)::bigint
  )`
}

export function assertMigration (schema: string, version: number) {
  // raises 'division by zero' if already on desired schema version
  return `SELECT version::int/(version::int-${version}) from ${schema}.version`
}

export function findJobs (schema: string, table: string, options: { queued: boolean, byKey: boolean, byData: boolean, byId: boolean }) {
  const { queued, byKey, byData, byId } = options

  let paramIndex = 1
  const whereConditions = []

  if (byId) {
    ++paramIndex
    whereConditions.push(`AND id = $${paramIndex}`)
  }

  if (byKey) {
    ++paramIndex
    whereConditions.push(`AND singleton_key = $${paramIndex}`)
  }

  if (byData) {
    ++paramIndex
    whereConditions.push(`AND data @> $${paramIndex}`)
  }

  if (queued) {
    whereConditions.push(`AND state < '${JOB_STATES.active}'`)
  }

  return `
    SELECT ${JOB_COLUMNS_ALL}
    FROM ${schema}.${table}
    WHERE name = $1
      ${whereConditions.join('\n      ')}
    `
}

export function getJobById (schema: string, table: string) {
  return `
    SELECT ${JOB_COLUMNS_ALL}
    FROM ${schema}.${table}
    WHERE name = $1
      AND id = $2
    `
}

// Pass `deps` to embed the payload as a literal (parameter-less) so the statement can be
// concatenated into a flow batch; omit it to get the parameterized ($1) form.
export function insertDependencies (schema: string, deps?: unknown[]) {
  const sql = `
    INSERT INTO ${schema}.job_dependency (child_name, child_id, parent_name, parent_id)
    SELECT child_name, child_id, parent_name, parent_id
    FROM json_to_recordset($1::json) AS x (
      child_name text,
      child_id uuid,
      parent_name text,
      parent_id uuid
    )
    ON CONFLICT DO NOTHING
  `

  return deps ? sql.replace('$1', () => serializeJsonParam(deps)) : sql
}

export function getDependencies (schema: string) {
  return `
    SELECT parent_name as "parentName", parent_id as "parentId"
    FROM ${schema}.job_dependency
    WHERE child_name = $1 AND child_id = $2
  `
}

export function getDependents (schema: string) {
  return `
    SELECT child_name as "childName", child_id as "childId"
    FROM ${schema}.job_dependency
    WHERE parent_name = $1 AND parent_id = $2
  `
}

export function cleanupDependencies (schema: string, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const sql = `
    DELETE FROM ${schema}.job_dependency
    WHERE (child_name = ANY(${serializeArrayParam(queues)})
      AND NOT EXISTS (
        SELECT 1 FROM ${schema}.${table} j
        WHERE j.name = child_name AND j.id = child_id
      ))
    OR (parent_name = ANY(${serializeArrayParam(queues)})
      AND NOT EXISTS (
        SELECT 1 FROM ${schema}.${table} j
        WHERE j.name = parent_name AND j.id = parent_id
      ))
  `

  return locked(schema, sql, table + 'cleanupDependencies', noAdvisoryLocks)
}

export function getBlockedKeys (schema: string, table: string) {
  return `
    SELECT DISTINCT singleton_key as "singletonKey"
    FROM ${schema}.${table}
    WHERE name = $1
      AND state = '${JOB_STATES.failed}'
      AND policy = '${QUEUE_POLICIES.key_strict_fifo}'
    `
}

export function getNextBamCommand (schema: string) {
  return `
    UPDATE ${schema}.bam
    SET status = 'in_progress', started_on = now()
    WHERE id = (
      SELECT id FROM ${schema}.bam
      WHERE status IN ('pending', 'failed')
        AND NOT EXISTS (SELECT 1 FROM ${schema}.bam WHERE status = 'in_progress')
      ORDER BY created_on
      LIMIT 1
    )
    RETURNING id, name, version, status, queue, table_name as "table", command, error,
              created_on as "createdOn", started_on as "startedOn", completed_on as "completedOn"
  `
}

export function setBamCompleted (schema: string, id: string) {
  return `
    UPDATE ${schema}.bam
    SET status = 'completed', completed_on = now()
    WHERE id = '${id}'
  `
}

export function setBamFailed (schema: string, id: string, error: string) {
  const escapedError = error.replace(/'/g, "''")
  return `
    UPDATE ${schema}.bam
    SET status = 'failed', error = '${escapedError}', completed_on = now()
    WHERE id = '${id}'
  `
}

export function getBamStatus (schema: string) {
  return `
    SELECT status, count(*)::int as count, max(created_on) as "lastCreatedOn"
    FROM ${schema}.bam
    GROUP BY status
  `
}

export function getBamEntries (schema: string) {
  return `
    SELECT id, name, version, status, queue, table_name as "table", command, error,
           created_on as "createdOn", started_on as "startedOn", completed_on as "completedOn"
    FROM ${schema}.bam
    ORDER BY version, created_on
  `
}
