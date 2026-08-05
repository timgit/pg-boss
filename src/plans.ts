import type { JobMatchStrategy, UpdateQueueOptions } from './types.ts'
import { normalizeSchemaName, resolveSchemaName } from './tools.ts'
import { type Ctx, type Dialect, qn, sch, dial } from './dialect.ts'

function qi (c: Ctx, index: string): string {
  return dial(c).qualifyIndex(sch(c), index)
}

// Postgres counts a mutation's affected rows via a data-modifying CTE; SQLite cannot put DML in a
// CTE, so the mutation runs top-level and the caller counts its RETURNING rows instead (see
// Manager.mapCommandResponse). `fromKeyword` preserves the original casing of `from results`.
function countMutation (c: Ctx, mutation: string, fromKeyword: 'from' | 'FROM' = 'from'): string {
  if (dial(c).name === 'sqlite') {
    return mutation
  }

  return `
    WITH results ${fromKeyword === 'FROM' ? 'AS' : 'as'} (
      ${mutation}
    )
    SELECT COUNT(*) ${fromKeyword} results
  `
}

export interface SqlQuery {
  text: string
  values: unknown[]
}

export const PG_ERROR = {
  divisionByZero: '22012'
}

export const DEFAULT_SCHEMA = 'pgboss'
export const CREATE_RACE_MESSAGE = 'already exists'
export const SINGLE_QUOTE_REGEX = /'/g
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

export const COMMON_JOB_TABLE = 'job_common'

interface CreateOptions {
  createSchema?: boolean
  noTablePartitioning?: boolean
  noDeferrableConstraints?: boolean
  noAdvisoryLocks?: boolean
  noCoveringIndexes?: boolean
}

export function create (c: Ctx, version: number, options?: CreateOptions) {
  if (dial(c).name === 'sqlite') {
    return createSqlite(c, version)
  }

  const noPartitioning = options?.noTablePartitioning ?? false
  const noDeferrable = options?.noDeferrableConstraints ?? false
  const noLocks = options?.noAdvisoryLocks ?? false
  const noCovering = options?.noCoveringIndexes ?? false

  const commands = [
    options?.createSchema ? createSchema(c) : '',
    createEnumJobState(c),

    createTableVersion(c),
    createTableQueue(c),
    createTableSchedule(c),

    // Partition-helper functions are only used by the partitioned architecture.
    // They are unused when partitioning is disabled, and job_table_format's
    // IMMUTABLE + format() body is rejected at create time by databases like
    // CockroachDB, so skip them entirely in noTablePartitioning mode.
    noPartitioning ? '' : jobTableFormatFunction(c),
    noPartitioning ? '' : jobTableRunFunction(c),

    createTableJob(c, noPartitioning),
    createPrimaryKeyJob(c),
    noPartitioning ? createTableJobIndexes(c, noDeferrable, noCovering) : createTableJobCommon(c),

    createTableJobDependency(c),
    createIndexJobDependencyParent(c),

    createQueueFunction(c, noPartitioning),
    deleteQueueFunction(c, noPartitioning),

    insertVersion(c, version)
  ]

  return locked(c, commands, undefined, noLocks)
}

// A random v4 uuid as a SQLite column-default expression, replacing gen_random_uuid().
const SQLITE_UUID_DEFAULT = "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))"

// ISO-8601 UTC now with milliseconds — the sqlite dialect's timestamp text representation.
const SQLITE_NOW_DEFAULT = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

function sqliteNowPlusSeconds (seconds: number): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ', unixepoch('subsec') + ${seconds}, 'unixepoch')`
}

// Renders a JS value as a SQLite literal. Never emits a double-quote character inside string
// literals — every caller passes attorney-validated identifiers/enum values — because Bun's
// sqlite driver mislexes them (see scripts/spike-bun-sqlite.ts); arbitrary user data must be
// bound as a parameter instead.
function sqliteLiteral (value: unknown): string {
  if (value === undefined || value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replace(SINGLE_QUOTE_REGEX, "''")}'`
}

// The full sqlite install: the non-partitioned schema shape with TEXT timestamps/uuids/json,
// INTEGER booleans, a CHECK-constrained TEXT state column, and inline foreign keys (SQLite has
// no ALTER TABLE ADD CONSTRAINT). Stored functions don't exist — create_queue/delete_queue are
// rendered as direct statements by their builders. Installs at the current schema version;
// there is no sqlite migration history.
function createSqlite (c: Ctx, version: number): string {
  const commands = [
    `CREATE TABLE ${qn(c, 'version')} (
      version integer primary key,
      cron_on text,
      flow_on text
    )`,
    `CREATE TABLE ${qn(c, 'queue')} (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit integer NOT NULL,
      retry_delay integer NOT NULL,
      retry_backoff integer NOT NULL,
      retry_delay_max integer,
      expire_seconds integer NOT NULL,
      retention_seconds integer NOT NULL,
      deletion_seconds integer NOT NULL,
      dead_letter text REFERENCES ${qn(c, 'queue')} (name) CHECK (dead_letter IS DISTINCT FROM name),
      partition integer NOT NULL,
      table_name text NOT NULL,
      deferred_count integer NOT NULL default 0,
      queued_count integer NOT NULL default 0,
      ready_count integer NOT NULL default 0,
      warning_queued integer NOT NULL default 0,
      active_count integer NOT NULL default 0,
      failed_count integer NOT NULL default 0,
      total_count integer NOT NULL default 0,
      ready_history text NOT NULL default '[]',
      heartbeat_seconds integer,
      notify integer NOT NULL DEFAULT 0,
      singletons_active text,
      monitor_on text,
      maintain_on text,
      created_on text not null default (${SQLITE_NOW_DEFAULT}),
      updated_on text not null default (${SQLITE_NOW_DEFAULT}),
      PRIMARY KEY (name)
    )`,
    `CREATE TABLE ${qn(c, 'schedule')} (
      name text REFERENCES ${qn(c, 'queue')} ON DELETE CASCADE,
      key text not null DEFAULT '',
      cron text not null,
      timezone text,
      data text,
      options text,
      created_on text not null default (${SQLITE_NOW_DEFAULT}),
      updated_on text not null default (${SQLITE_NOW_DEFAULT}),
      PRIMARY KEY (name, key)
    )`,
    `CREATE TABLE ${qn(c, 'job')} (
      id text not null default (${SQLITE_UUID_DEFAULT}),
      name text not null,
      priority integer not null default(0),
      data text,
      state text not null default '${JOB_STATES.created}'
        CHECK (state IN (${Object.keys(JOB_STATES).map(s => `'${s}'`).join(', ')})),
      retry_limit integer not null default ${QUEUE_DEFAULTS.retry_limit},
      retry_count integer not null default 0,
      retry_delay integer not null default ${QUEUE_DEFAULTS.retry_delay},
      retry_backoff integer not null default ${QUEUE_DEFAULTS.retry_backoff ? 1 : 0},
      retry_delay_max integer,
      expire_seconds integer not null default ${QUEUE_DEFAULTS.expire_seconds},
      deletion_seconds integer not null default ${QUEUE_DEFAULTS.deletion_seconds},
      singleton_key text,
      singleton_on text,
      group_id text,
      group_tier text,
      start_after text not null default (${SQLITE_NOW_DEFAULT}),
      created_on text not null default (${SQLITE_NOW_DEFAULT}),
      started_on text,
      completed_on text,
      keep_until text NOT NULL default (${sqliteNowPlusSeconds(QUEUE_DEFAULTS.retention_seconds)}),
      output text,
      dead_letter text,
      policy text,
      heartbeat_on text,
      heartbeat_seconds integer,
      blocked integer not null default 0,
      blocking integer not null default 0,
      pending_dependencies integer not null default 0,
      source_name text,
      source_id text,
      source_created_on text,
      source_retry_count integer,
      PRIMARY KEY (name, id),
      FOREIGN KEY (name) REFERENCES ${qn(c, 'queue')} (name) ON DELETE RESTRICT,
      FOREIGN KEY (dead_letter) REFERENCES ${qn(c, 'queue')} (name) ON DELETE RESTRICT
    )`,
    createIndexJobPolicyShort(c),
    createIndexJobPolicySingleton(c),
    createIndexJobPolicyStately(c),
    createIndexJobThrottle(c),
    createIndexJobFetch(c),
    createIndexJobPolicyExclusive(c),
    createIndexJobGroupConcurrency(c),
    createIndexJobBlocking(c),
    `CREATE TABLE ${qn(c, 'job_dependency')} (
      child_name text NOT NULL,
      child_id text NOT NULL,
      parent_name text NOT NULL,
      parent_id text NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )`,
    createIndexJobDependencyParent(c),
    insertVersion(c, version)
  ]

  return transaction(c, commands)
}

function createSchema (c: Ctx) {
  return `CREATE SCHEMA IF NOT EXISTS ${sch(c)}`
}

function createEnumJobState (c: Ctx) {
  // ENUM definition order is important
  // base type is numeric and first values are less than last values
  return `
    CREATE TYPE ${qn(c, 'job_state')} AS ENUM (
      '${JOB_STATES.created}',
      '${JOB_STATES.retry}',
      '${JOB_STATES.active}',
      '${JOB_STATES.completed}',
      '${JOB_STATES.cancelled}',
      '${JOB_STATES.failed}'
    )
  `
}

function createTableVersion (c: Ctx) {
  return `
    CREATE TABLE ${qn(c, 'version')} (
      version int primary key,
      cron_on timestamp with time zone,
      flow_on timestamp with time zone
    )
  `
}

function createTableQueue (c: Ctx) {
  return `
    CREATE TABLE ${qn(c, 'queue')} (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit int NOT NULL,
      retry_delay int NOT NULL,
      retry_backoff bool NOT NULL,
      retry_delay_max int,
      expire_seconds int NOT NULL,
      retention_seconds int NOT NULL,
      deletion_seconds int NOT NULL,
      dead_letter text REFERENCES ${qn(c, 'queue')} (name) CHECK (dead_letter IS DISTINCT FROM name),
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

function createTableSchedule (c: Ctx) {
  return `
    CREATE TABLE ${qn(c, 'schedule')} (
      name text REFERENCES ${qn(c, 'queue')} ON DELETE CASCADE,
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

export function createTableJobDependency (c: Ctx) {
  return `
    CREATE TABLE ${qn(c, 'job_dependency')} (
      child_name text NOT NULL,
      child_id uuid NOT NULL,
      parent_name text NOT NULL,
      parent_id uuid NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )
  `
}

export function createIndexJobDependencyParent (c: Ctx) {
  return `CREATE INDEX IF NOT EXISTS ${qi(c, 'job_dep_parent_idx')} ON ${qn(c, 'job_dependency')} (parent_name, parent_id)`
}

// Anchored so a schema name that itself contains these substrings (e.g. `job_intake`) isn't
// mangled: `\.job\y` matches only the base table reference (`schema.job`, not `schema.job_i5` whose
// `job` is followed by `_`, nor `.job_dependency`), and `\yjob_i(\d+)` matches only the bare
// index-name tokens (job_i1..9), never the `job_i` inside a schema name.
export function jobTableFormatFunction (c: Ctx) {
  return `
    CREATE FUNCTION ${qn(c, 'job_table_format')}(command text, table_name text)
    RETURNS text AS
    $$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\\.job\\y', '.%1$I', 'g'),
          '\\yjob_i(\\d+)', '%1$s_i\\1', 'g'
        ),
        table_name
      );
    $$
    LANGUAGE sql IMMUTABLE;
  `
}

function jobTableRunFunction (c: Ctx) {
  return `
    CREATE FUNCTION ${qn(c, 'job_table_run')}(command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM ${qn(c, 'queue')} WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE ${qn(c, 'job_table_format')}(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE ${qn(c, 'job_table_format')}(command, '${COMMON_JOB_TABLE}');

      FOR tbl IN SELECT table_name FROM ${qn(c, 'queue')} WHERE partition = true
      LOOP
        EXECUTE ${qn(c, 'job_table_format')}(command, tbl.table_name);
      END LOOP;
    END;
    $$
    LANGUAGE plpgsql;
  `
}

function createTableJob (c: Ctx, noPartitioning = false) {
  const partitionClause = noPartitioning ? '' : 'PARTITION BY LIST (name)'
  return `
    CREATE TABLE ${qn(c, 'job')} (
      id uuid not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state ${qn(c, 'job_state')} not null default '${JOB_STATES.created}',
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

function createTableJobCommon (c: Ctx) {
  return `
    CREATE TABLE ${qn(c, COMMON_JOB_TABLE)} (LIKE ${qn(c, 'job')} INCLUDING GENERATED INCLUDING DEFAULTS);

    SELECT ${qn(c, 'job_table_run')}($cmd$${createPrimaryKeyJob(c)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${qn(c, 'job_table_run')}($cmd$${createQueueForeignKeyJob(c)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${qn(c, 'job_table_run')}($cmd$${createQueueForeignKeyJobDeadLetter(c)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${qn(c, 'job_table_run')}($cmd$${createIndexJobPolicyShort(c)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${qn(c, 'job_table_run')}($cmd$${createIndexJobPolicySingleton(c)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${qn(c, 'job_table_run')}($cmd$${createIndexJobPolicyStately(c)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${qn(c, 'job_table_run')}($cmd$${createIndexJobPolicyExclusive(c)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${qn(c, 'job_table_run')}($cmd$${createIndexJobThrottle(c)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${qn(c, 'job_table_run')}($cmd$${createIndexJobFetch(c)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${qn(c, 'job_table_run')}($cmd$${createIndexJobGroupConcurrency(c)}$cmd$, '${COMMON_JOB_TABLE}');
    SELECT ${qn(c, 'job_table_run')}($cmd$${createIndexJobBlocking(c)}$cmd$, '${COMMON_JOB_TABLE}');

    ALTER TABLE ${qn(c, 'job')} ATTACH PARTITION ${qn(c, COMMON_JOB_TABLE)} DEFAULT;
  `
}

// Creates indexes directly on job table when partitioning is disabled
function createTableJobIndexes (c: Ctx, noDeferrableConstraints = false, noCoveringIndex = false) {
  return `
    ${createQueueForeignKeyJob(c, noDeferrableConstraints)};
    ${createQueueForeignKeyJobDeadLetter(c, noDeferrableConstraints)};
    ${createIndexJobPolicyShort(c)};
    ${createIndexJobPolicySingleton(c)};
    ${createIndexJobPolicyStately(c)};
    ${createIndexJobPolicyExclusive(c)};
    ${createIndexJobThrottle(c)};
    ${createIndexJobFetch(c, noCoveringIndex)};
    ${createIndexJobGroupConcurrency(c)};
    ${createIndexJobBlocking(c)};
  `
}

function createQueueFunction (c: Ctx, noPartitioning = false) {
  if (noPartitioning) {
    // Simplified version without table partitioning support
    return `
      CREATE FUNCTION ${qn(c, 'create_queue')}(queue_name text, options jsonb)
      RETURNS VOID AS
      $$
      BEGIN
        INSERT INTO ${qn(c, 'queue')} (
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
    CREATE FUNCTION ${qn(c, 'create_queue')}(queue_name text, options jsonb)
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
        INSERT INTO ${qn(c, 'queue')} (
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

      EXECUTE format('CREATE TABLE ${sch(c)}.%I (LIKE ${qn(c, 'job')} INCLUDING DEFAULTS)', tablename);

      EXECUTE ${qn(c, 'job_table_format')}($cmd$${createPrimaryKeyJob(c)}$cmd$, tablename);
      EXECUTE ${qn(c, 'job_table_format')}($cmd$${createQueueForeignKeyJob(c)}$cmd$, tablename);
      EXECUTE ${qn(c, 'job_table_format')}($cmd$${createQueueForeignKeyJobDeadLetter(c)}$cmd$, tablename);

      EXECUTE ${qn(c, 'job_table_format')}($cmd$${createIndexJobFetch(c)}$cmd$, tablename);
      EXECUTE ${qn(c, 'job_table_format')}($cmd$${createIndexJobThrottle(c)}$cmd$, tablename);
      EXECUTE ${qn(c, 'job_table_format')}($cmd$${createIndexJobGroupConcurrency(c)}$cmd$, tablename);
      EXECUTE ${qn(c, 'job_table_format')}($cmd$${createIndexJobBlocking(c)}$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE ${qn(c, 'job_table_format')}($cmd$${createIndexJobPolicyShort(c)}$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE ${qn(c, 'job_table_format')}($cmd$${createIndexJobPolicySingleton(c)}$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE ${qn(c, 'job_table_format')}($cmd$${createIndexJobPolicyStately(c)}$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE ${qn(c, 'job_table_format')}($cmd$${createIndexJobPolicyExclusive(c)}$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE ${sch(c)}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE ${qn(c, 'job')} ATTACH PARTITION ${sch(c)}.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `
}

function deleteQueueFunction (c: Ctx, noPartitioning = false) {
  const deleteJobsSql = noPartitioning
    ? `DELETE FROM ${qn(c, 'job')} WHERE name = queue_name;`
    : `
      SELECT table_name, partition
      FROM ${qn(c, 'queue')}
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS ${sch(c)}.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM ${sch(c)}.%I WHERE name = %L', v_table, queue_name);
      END IF;
    `

  const declareBlock = noPartitioning
    ? ''
    : `
    DECLARE
      v_table varchar;
      v_partition bool;`

  return `
    CREATE FUNCTION ${qn(c, 'delete_queue')}(queue_name text)
    RETURNS VOID AS
    $$${declareBlock}
    BEGIN
      ${deleteJobsSql}
      DELETE FROM ${qn(c, 'queue')} WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  `
}

export function createQueue (c: Ctx, name: string, options: unknown, noAdvisoryLocks?: boolean) {
  if (dial(c).name === 'sqlite') {
    return locked(c, createQueueSqlite(c, name, options), 'create-queue', noAdvisoryLocks)
  }

  const sql = `SELECT ${qn(c, 'create_queue')}('${name}', '${JSON.stringify(options)}'::jsonb)`
  return locked(c, sql, 'create-queue', noAdvisoryLocks)
}

// Mirrors the non-partitioned create_queue() function body (SQLite has no stored functions),
// with defaults resolved here instead of in-database. Values are attorney-validated, so
// literal rendering is safe.
function createQueueSqlite (c: Ctx, name: string, options: unknown): string {
  const opts = (options ?? {}) as Record<string, unknown>

  return `
    INSERT INTO ${qn(c, 'queue')} (
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
      ${sqliteLiteral(name)},
      ${sqliteLiteral(opts.policy)},
      ${sqliteLiteral(opts.retryLimit ?? QUEUE_DEFAULTS.retry_limit)},
      ${sqliteLiteral(opts.retryDelay ?? QUEUE_DEFAULTS.retry_delay)},
      ${sqliteLiteral(opts.retryBackoff ?? QUEUE_DEFAULTS.retry_backoff)},
      ${sqliteLiteral(opts.retryDelayMax)},
      ${sqliteLiteral(opts.expireInSeconds ?? QUEUE_DEFAULTS.expire_seconds)},
      ${sqliteLiteral(opts.retentionSeconds ?? QUEUE_DEFAULTS.retention_seconds)},
      ${sqliteLiteral(opts.deleteAfterSeconds ?? QUEUE_DEFAULTS.deletion_seconds)},
      ${sqliteLiteral(opts.warningQueueSize ?? QUEUE_DEFAULTS.warning_queued)},
      ${sqliteLiteral(opts.deadLetter)},
      0,
      'job',
      ${sqliteLiteral(opts.heartbeatSeconds)}
    )
    ON CONFLICT DO NOTHING
  `
}

// LISTEN/NOTIFY channels share a single database-global namespace and are limited to
// NAMEDATALEN (63 bytes), unlike the rest of bun-boss which is schema-bound. Derive a
// stable, collision-resistant channel from the schema so separate bun-boss instances
// (and other services) on the same database never clash. Payload carries the queue name.
//
// Returns a SQL scalar expression (not a value) hashed in-database with sha224, matching
// the convention used by advisoryLock() and partition table naming. Both the producer
// (inlined into the insert) and the listener (resolved once at startup) derive the channel
// from this single expression, so they always agree. The 'pgboss_' prefix keeps the
// channel human-recognizable in pg_stat_activity; 24 hex chars leaves ample headroom under
// the 63-byte identifier limit. Channels are already scoped to a single database, so unlike
// advisoryLock there is no need to mix in current_database().
//
// normalizeSchemaName, not resolveSchemaName: the channel is never matched against the catalog, so
// it only has to agree across instances on the same schema. See the note on the helper.
export function notifyChannelSql (c: Ctx): string {
  return `('pgboss_' || left(encode(sha224('${normalizeSchemaName(sch(c))}'::bytea), 'hex'), 24))`
}

// Parameter-less statement that wakes workers on a notify-enabled queue. Embedded into
// flow batches so it commits in the same transaction as the inserts.
export function notifyQueue (c: Ctx, name: string): string {
  return `SELECT pg_notify(${notifyChannelSql(c)}, '${name}')`
}

export function deleteQueue (c: Ctx, name: string, noAdvisoryLocks?: boolean) {
  // Mirrors the non-partitioned delete_queue() function body: jobs first — the queue FK is RESTRICT.
  if (dial(c).name === 'sqlite') {
    const statements = [
      `DELETE FROM ${qn(c, 'job')} WHERE name = ${sqliteLiteral(name)}`,
      `DELETE FROM ${qn(c, 'queue')} WHERE name = ${sqliteLiteral(name)}`
    ]
    return locked(c, statements, 'delete-queue', noAdvisoryLocks)
  }

  const sql = `SELECT ${qn(c, 'delete_queue')}('${name}')`
  return locked(c, sql, 'delete-queue', noAdvisoryLocks)
}

function createPrimaryKeyJob (c: Ctx) {
  return `ALTER TABLE ${qn(c, 'job')} ADD PRIMARY KEY (name, id)`
}

function createQueueForeignKeyJob (c: Ctx, noPartitioning = false) {
  const deferrable = noPartitioning ? '' : ' DEFERRABLE INITIALLY DEFERRED'
  return `ALTER TABLE ${qn(c, 'job')} ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${qn(c, 'queue')} (name) ON DELETE RESTRICT${deferrable}`
}

function createQueueForeignKeyJobDeadLetter (c: Ctx, noPartitioning = false) {
  const deferrable = noPartitioning ? '' : ' DEFERRABLE INITIALLY DEFERRED'
  return `ALTER TABLE ${qn(c, 'job')} ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${qn(c, 'queue')} (name) ON DELETE RESTRICT${deferrable}`
}

function createIndexJobPolicyShort (c: Ctx) {
  return `CREATE UNIQUE INDEX ${qi(c, 'job_i1')} ON ${qn(c, 'job')} (name, COALESCE(singleton_key, '')) WHERE state = '${JOB_STATES.created}' AND policy = '${QUEUE_POLICIES.short}'`
}

function createIndexJobPolicySingleton (c: Ctx) {
  return `CREATE UNIQUE INDEX ${qi(c, 'job_i2')} ON ${qn(c, 'job')} (name, COALESCE(singleton_key, '')) WHERE state = '${JOB_STATES.active}' AND policy = '${QUEUE_POLICIES.singleton}'`
}

function createIndexJobPolicyStately (c: Ctx) {
  return `CREATE UNIQUE INDEX ${qi(c, 'job_i3')} ON ${qn(c, 'job')} (name, state, COALESCE(singleton_key, '')) WHERE ${dial(c).stateLte('state', JOB_STATES.active)} AND policy = '${QUEUE_POLICIES.stately}'`
}

function createIndexJobThrottle (c: Ctx) {
  return `CREATE UNIQUE INDEX ${qi(c, 'job_i4')} ON ${qn(c, 'job')} (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> '${JOB_STATES.cancelled}' AND singleton_on IS NOT NULL`
}

function createIndexJobFetch (c: Ctx, noCoveringIndex = false) {
  // No covering INCLUDE: the fetch locks candidate rows with FOR UPDATE ... SKIP LOCKED, which
  // forces heap access, so an index-only scan is impossible and a covering payload would never be
  // read from the index. Confirmed dead weight via EXPLAIN ANALYZE;
  // dropping it shrinks job_i5 on the hot insert path at no read-side cost.
  // noCoveringIndex (the CockroachDB profile flag that stripped the old INCLUDE) is now moot here.
  return `CREATE INDEX ${qi(c, 'job_i5')} ON ${qn(c, 'job')} (name, start_after) WHERE ${dial(c).stateLt('state', JOB_STATES.active)} AND NOT blocked`
}

function createIndexJobPolicyExclusive (c: Ctx) {
  return `CREATE UNIQUE INDEX ${qi(c, 'job_i6')} ON ${qn(c, 'job')} (name, COALESCE(singleton_key, '')) WHERE ${dial(c).stateLte('state', JOB_STATES.active)} AND policy = '${QUEUE_POLICIES.exclusive}'`
}

function createIndexJobGroupConcurrency (c: Ctx) {
  return `CREATE INDEX ${qi(c, 'job_i7')} ON ${qn(c, 'job')} (name, group_id) WHERE state = '${JOB_STATES.active}' AND group_id IS NOT NULL`
}

// Partial index supporting the background flow resolver (Navigator): lets it find completed
// blocking parents with an index scan instead of a partition-wide scan. The `state = completed`
// predicate keeps still-running and permanently-failed blocking parents out of the index, so
// non-flow queues (and high-partition-count deployments) carry an empty index that costs nothing.
function createIndexJobBlocking (c: Ctx) {
  return `CREATE INDEX ${qi(c, 'job_i9')} ON ${qn(c, 'job')} (name, id) WHERE blocking AND state = '${JOB_STATES.completed}'`
}

export function trySetQueueMonitorTime (c: Ctx, queues: string[], seconds: number): SqlQuery {
  return trySetQueueTimestamp(c, queues, 'monitor_on', seconds)
}

export function trySetQueueDeletionTime (c: Ctx, queues: string[], seconds: number): SqlQuery {
  return trySetQueueTimestamp(c, queues, 'maintain_on', seconds)
}

export function trySetCronTime (c: Ctx, seconds: number) {
  return trySetTimestamp(c, 'cron_on', seconds)
}

export function trySetFlowTime (c: Ctx, seconds: number) {
  return trySetTimestamp(c, 'flow_on', seconds)
}

function trySetTimestamp (c: Ctx, column: string, seconds: number) {
  return `
    UPDATE ${qn(c, 'version')}
    SET ${column} = ${dial(c).now()}
    WHERE ${dial(c).staleAfter(column, seconds)}
    RETURNING true
  `
}

function trySetQueueTimestamp (c: Ctx, queues: string[], column: string, seconds: number): SqlQuery {
  return {
    text: `
    UPDATE ${qn(c, 'queue')}
    SET ${column} = ${dial(c).now()}
    WHERE ${dial(c).inArrayParam('name', '$1', 'text[]')}
      AND ${dial(c).staleAfter(column, seconds)}
    RETURNING name
  `,
    values: [queues]
  }
}

export function updateQueue (c: Ctx, { deadLetter }: UpdateQueueOptions = {}) {
  const d = dial(c)
  return `
    WITH options as (SELECT ${d.jsonParam('$2')} as data)
    UPDATE ${qn(c, 'queue')} SET
      retry_limit = COALESCE(${d.jsonGet('o.data', 'retryLimit', 'int')}, retry_limit),
      retry_delay = COALESCE(${d.jsonGet('o.data', 'retryDelay', 'int')}, retry_delay),
      retry_backoff = COALESCE(${d.jsonGet('o.data', 'retryBackoff', 'bool')}, retry_backoff),
      retry_delay_max = CASE WHEN ${d.jsonHasKey('o.data', 'retryDelayMax')}
        THEN ${d.jsonGet('o.data', 'retryDelayMax', 'int')}
        ELSE retry_delay_max END,
      expire_seconds = COALESCE(${d.jsonGet('o.data', 'expireInSeconds', 'int')}, expire_seconds),
      retention_seconds = COALESCE(${d.jsonGet('o.data', 'retentionSeconds', 'int')}, retention_seconds),
      deletion_seconds = COALESCE(${d.jsonGet('o.data', 'deleteAfterSeconds', 'int')}, deletion_seconds),
      warning_queued = COALESCE(${d.jsonGet('o.data', 'warningQueueSize', 'int')}, warning_queued),
      heartbeat_seconds = CASE WHEN ${d.jsonHasKey('o.data', 'heartbeatSeconds')}
        THEN ${d.jsonGet('o.data', 'heartbeatSeconds', 'int')}
        ELSE heartbeat_seconds END,
      notify = COALESCE(${d.jsonGet('o.data', 'notify', 'bool')}, notify),
      ${
        deadLetter === undefined
          ? ''
          : `dead_letter = CASE WHEN '${deadLetter}' IS DISTINCT FROM dead_letter THEN '${deadLetter}' ELSE dead_letter END,`
      }
      updated_on = ${d.now()}
    FROM options o
    WHERE name = $1
  `
}

export function getQueues (c: Ctx, names?: string[]): SqlQuery {
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
    FROM ${qn(c, 'queue')} q
    ${hasNames ? `WHERE ${dial(c).inArrayParam('q.name', '$1', 'text[]')}` : ''}
   `,
    values: hasNames ? [names] : []
  }
}

export function deleteJobsById (c: Ctx, table: string) {
  const d = dial(c)
  const mutation = `DELETE FROM ${qn(c, table)}
      WHERE name = $1
        AND ${d.inArrayParam('id', '$2', 'uuid[]')}
      RETURNING 1`

  return countMutation(c, mutation)
}

export function deleteQueuedJobs (c: Ctx, table: string) {
  return `DELETE from ${qn(c, table)} WHERE name = $1 and ${dial(c).stateLt('state', JOB_STATES.active)}`
}

export function deleteStoredJobs (c: Ctx, table: string) {
  return `DELETE from ${qn(c, table)} WHERE name = $1 and ${dial(c).stateGt('state', JOB_STATES.active)}`
}

export function truncateTable (c: Ctx, table: string) {
  // SQLite has no TRUNCATE statement; an unqualified DELETE takes its internal truncate optimization instead.
  if (dial(c).name === 'sqlite') {
    return `DELETE FROM ${qn(c, table)}`
  }

  return `TRUNCATE ${qn(c, table)}`
}

export function deleteAllJobs (c: Ctx, table: string) {
  return `DELETE from ${qn(c, table)} WHERE name = $1`
}

export function getSchedules (c: Ctx) {
  return `SELECT * FROM ${qn(c, 'schedule')} ORDER BY name, key`
}

export function getSchedulesByQueue (c: Ctx) {
  return `SELECT * FROM ${qn(c, 'schedule')} WHERE name = $1 ORDER BY key`
}

export function getSchedulesByQueueAndKey (c: Ctx) {
  return `SELECT * FROM ${qn(c, 'schedule')} WHERE name = $1 AND COALESCE(key, '') = $2`
}

export function schedule (c: Ctx) {
  return `
    INSERT INTO ${qn(c, 'schedule')} (name, key, cron, timezone, data, options)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (name, key) DO UPDATE SET
      cron = EXCLUDED.cron,
      timezone = EXCLUDED.timezone,
      data = EXCLUDED.data,
      options = EXCLUDED.options,
      updated_on = ${dial(c).now()}
  `
}

export function unschedule (c: Ctx) {
  return `
    DELETE FROM ${qn(c, 'schedule')}
    WHERE name = $1
      AND COALESCE(key, '') = $2
  `
}

export function getTime (c: Ctx) {
  if (dial(c).name === 'sqlite') {
    return "SELECT CAST(round(unixepoch('subsec') * 1000) AS INTEGER) as time"
  }

  return "SELECT round(date_part('epoch', now()) * 1000) as time"
}

// Cheap single-row read of the cached counts the monitor maintains on the queue table. capturedOn
// is monitor_on — the moment those counts were last refreshed, or NULL if the queue has never been
// monitored (so the caller knows to recompute rather than trust default-zero counts).
export function getQueueStatsCache (c: Ctx): string {
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
    FROM ${qn(c, 'queue')}
    WHERE name = $1
  `
}

export function getVersion (c: Ctx) {
  return `SELECT version from ${qn(c, 'version')}`
}

export function setVersion (c: Ctx, version: number) {
  return `UPDATE ${qn(c, 'version')} SET version = '${version}'`
}

export function versionTableExists (c: Ctx) {
  // Both branches return exactly one row with a null name when not installed — isInstalled
  // reads rows[0].name unconditionally.
  if (dial(c).name === 'sqlite') {
    return `SELECT (SELECT name FROM sqlite_schema WHERE type = 'table' AND name = '${resolveSchemaName(sch(c))}.version') as name`
  }

  return `SELECT to_regclass('${qn(c, 'version')}') as name`
}

// Installed bun-boss schemas whose name differs from the configured one by case alone. Postgres
// folds a bare name and stores a quoted one verbatim, so `MySchema` and `"MySchema"` are two
// schemas that look nearly identical in config. Used on the install path to tell a caller who
// mis-spelled the quoting that their data is next door, rather than silently installing a second,
// empty schema beside the populated one.
export function getSchemaCaseVariants (c: Ctx): string {
  const resolved = resolveSchemaName(sch(c)).replace(SINGLE_QUOTE_REGEX, "''")
  return `
    SELECT n.nspname as name
    FROM pg_namespace n
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'version' AND c.relkind IN ('r', 'p')
    WHERE lower(n.nspname) = lower('${resolved}') AND n.nspname <> '${resolved}'
    ORDER BY n.nspname
  `
}

export function getPartitionedQueueTables (c: Ctx) {
  return `SELECT table_name FROM ${qn(c, 'queue')} WHERE partition = true`
}

export function insertVersion (c: Ctx, version: number) {
  return `INSERT INTO ${qn(c, 'version')}(version) VALUES ('${version}')`
}

interface GroupConcurrencyConfig {
  default: number
  tiers?: Record<string, number>
}

interface FetchJobOptions {
  schema: string
  dialect?: Dialect
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
    ignoreSingletonsParam = `$${paramIndex}`
    // job_i2/job_i3 key singleton/stately jobs on the empty key (COALESCE(singleton_key, ''))
    // as one slot, so a keyless active job must block keyless pending jobs the same way a keyed
    // one blocks its key. Map null -> '' here so the WHERE clause's COALESCE comparison (below)
    // never has to compare against a literal NULL array element, which would make `<> ALL(...)`
    // evaluate to NULL (excluding every row) instead of the intended per-key filter.
    values.push(ignoreSingletons.map(key => key ?? ''))
  }

  if (hasIgnoreGroups) {
    paramIndex++
    ignoreGroupsParam = `$${paramIndex}`
    values.push(ignoreGroups)
  }

  if (hasGroupConcurrency && groupConcurrencyConfig) {
    paramIndex++
    defaultGroupLimitParam = `$${paramIndex}`
    values.push(groupConcurrencyConfig.default)

    if (hasTiers) {
      paramIndex++
      tiersParam = `$${paramIndex}`
      values.push(JSON.stringify(groupConcurrencyConfig.tiers))
    }
  }

  if (hasMinPriority) {
    paramIndex++
    minPriorityParam = `$${paramIndex}`
    values.push(minPriority)
  }

  if (hasMaxPriority) {
    paramIndex++
    maxPriorityParam = `$${paramIndex}`
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
  const c: Ctx = options
  const d = dial(c)

  // SQLite has no row locking at all; the atomic-claim shape is mandatory whatever the caller
  // passed (the sqlite profile sets noSkipLocked, but direct builder calls may not).
  noSkipLocked = noSkipLocked || d.name === 'sqlite'
  const { table, name, policy, limit, includeMetadata, priority = true, orderByCreatedOn = true, ignoreStartAfter = false, groupConcurrency, minPriority, maxPriority } = options

  const singletonFetch = limit > 1 && (policy === QUEUE_POLICIES.singleton || policy === QUEUE_POLICIES.stately)
  const hasIgnoreSingletons = options.ignoreSingletons != null && options.ignoreSingletons.length > 0
  const hasIgnoreGroups = options.ignoreGroups != null && options.ignoreGroups.length > 0
  const hasGroupConcurrency = groupConcurrency != null
  const hasMinPriority = minPriority != null
  const hasMaxPriority = maxPriority != null
  const groupConcurrencyConfig = hasGroupConcurrency
    ? (typeof groupConcurrency === 'number' ? { default: groupConcurrency } : groupConcurrency)
    : null
  const hasTiers = hasGroupConcurrency &&
    groupConcurrencyConfig?.tiers &&
    Object.keys(groupConcurrencyConfig.tiers).length > 0
  const hasSingleGroupConcurrency = hasGroupConcurrency && !hasTiers && groupConcurrencyConfig?.default === 1
  const hasActiveGroupCounts = hasGroupConcurrency && !hasSingleGroupConcurrency

  const params = buildFetchParams(options)
  const groupLimit = hasTiers
    ? `COALESCE(${d.jsonGetExpr(d.jsonParam(params.tiersParam), 'group_tier', 'int')}, ${d.intParam(params.defaultGroupLimitParam)})`
    : d.intParam(params.defaultGroupLimitParam)
  const activeGroupCountExpression = hasActiveGroupCounts
    ? `COALESCE(${d.jsonGetExpr('(SELECT counts FROM active_group_count_map)', 'j.group_id', 'int')}, 0)`
    : ''

  const selectCols = [
    'j.id',
    singletonFetch ? 'j.singleton_key' : '',
    hasGroupConcurrency ? 'j.group_id, j.group_tier' : '',
    hasActiveGroupCounts ? `${activeGroupCountExpression} as active_cnt` : ''
  ].filter(Boolean).join(', ')

  // For limits above 1, aggregate active counts into a single JSONB value. Each
  // candidate uses a keyed lookup through an uncorrelated InitPlan, so the planner
  // cannot turn stale active-group estimates into a per-candidate relation scan.
  const activeGroupCountMapCte = hasActiveGroupCounts
    ? `active_group_count_map AS MATERIALIZED (
        SELECT ${d.jsonObjectAgg('group_id', 'active_cnt')} as counts
        FROM (
          SELECT group_id, ${d.castInt('COUNT(*)')} as active_cnt
          FROM ${qn(c, table)}
          WHERE name = '${name}' AND state = '${JOB_STATES.active}' AND group_id IS NOT NULL
          GROUP BY group_id
        ) active_groups
      ), `
    : ''

  // With noSkipLocked, omit FOR UPDATE SKIP LOCKED as it performs poorly
  // in distributed databases like CockroachDB
  const lockClause = noSkipLocked ? '' : 'FOR UPDATE OF j SKIP LOCKED'

  // Column references are qualified with j. throughout so both the base case and
  // the groupConcurrency branches share one set of expressions.
  const groupConcurrencyFilter = hasGroupConcurrency
    ? hasSingleGroupConcurrency
      ? `(j.group_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM ${qn(c, table)} active_group_probe
              WHERE active_group_probe.name = '${name}'
                AND active_group_probe.state = '${JOB_STATES.active}'
                AND active_group_probe.group_id IS NOT NULL
                AND active_group_probe.group_id = j.group_id
            ))`
      : `(j.group_id IS NULL
            OR ${activeGroupCountExpression} < ${groupLimit})`
    : ''

  const whereConditions = [
    `j.name = '${name}'`,
    dial(c).stateLt('j.state', JOB_STATES.active),
    'NOT j.blocked',
    // `<=` (not `<`) so a job inserted with the default start_after = now() is immediately
    // fetchable in the next statement. `now()` is transaction-scoped; on backends with coarse
    // clock resolution (notably PGlite) consecutive autocommit statements often share the same
    // timestamp, so `<` would leave freshly-inserted jobs invisible until the clock ticks.
    // NOTIFY gating already uses `start_after <= now()` for the same reason.
    !ignoreStartAfter ? `j.start_after <= ${d.now()}` : '',
    hasIgnoreSingletons ? d.notInArrayParam("COALESCE(j.singleton_key, '')", params.ignoreSingletonsParam, 'text[]') : '',
    hasIgnoreGroups ? `(j.group_id IS NULL OR ${d.notInArrayParam('j.group_id', params.ignoreGroupsParam, 'text[]')})` : '',
    hasMinPriority ? `j.priority >= ${d.intParam(params.minPriorityParam)}` : '',
    hasMaxPriority ? `j.priority <= ${d.intParam(params.maxPriorityParam)}` : '',
    groupConcurrencyFilter
  ].filter(Boolean).join('\n          AND ')

  const nextCte = `
      next AS (
        SELECT ${selectCols}
        FROM ${qn(c, table)} j
        WHERE ${whereConditions}
        ORDER BY ${priority ? 'j.priority desc, ' : ''}${orderByCreatedOn ? 'j.created_on, ' : ''}j.id
        LIMIT ${limit}
        ${lockClause}
      )`

  const singletonCte = singletonFetch
    ? `, singleton_ranking AS (
        SELECT id, ${hasGroupConcurrency ? 'group_id, group_tier, ' : ''}${hasActiveGroupCounts ? 'active_cnt, ' : ''}
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
          , ${hasActiveGroupCounts ? 't.active_cnt' : '0'} as active_cnt
        FROM ${singletonFetch ? 'singleton_ranking' : 'next'} t
        ${singletonFetch ? 'WHERE singleton_rn = 1' : ''}
      ),
      group_filtered AS (
        SELECT id FROM group_ranking
        WHERE group_id IS NULL
          OR (active_cnt + group_rn) <= ${groupLimit}
      )`
    : ''

  const finalCte = hasGroupConcurrency
    ? 'group_filtered'
    : (singletonFetch)
        ? 'singleton_ranking'
        : 'next'

  // An uncorrelated array InitPlan makes the selected ids a one-time input to the
  // UPDATE. Without it, stale estimates can make Postgres put the inlined ranking
  // query on the inner side of a nested loop and execute it once per job table row.
  const updateSource = hasGroupConcurrency ? '' : `FROM ${finalCte}`
  const updateMatch = hasGroupConcurrency
    ? d.inSubquery('j.id', `SELECT id FROM ${finalCte}`)
    : `j.id = ${finalCte}.id`

  // Without SKIP LOCKED, add a state check to prevent duplicate processing
  // when multiple workers try to claim the same jobs concurrently
  const distributedStateCheck = noSkipLocked ? `AND ${d.stateLt('j.state', JOB_STATES.active)}` : ''

  return {
    text: `
      WITH
      ${activeGroupCountMapCte}
      ${nextCte}
      ${singletonCte}
      ${groupConcurrencyCtes}
      UPDATE ${d.updateAlias(qn(c, table), 'j')} SET
        state = '${JOB_STATES.active}',
        started_on = ${d.now()},
        heartbeat_on = ${d.now()},
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      ${updateSource}
      WHERE name = '${name}' AND ${updateMatch}
      ${singletonFetch && !hasGroupConcurrency ? 'AND singleton_rn = 1' : ''}
      ${distributedStateCheck}
      RETURNING ${d.returningAlias('j')}${includeMetadata ? JOB_COLUMNS_ALL : JOB_COLUMNS_MIN}${
        // SQLite's RETURNING row order is unspecified, so emit the claim-ordering keys for the
        // manager to re-sort by (metadata fetches already carry priority/createdOn).
        d.name === 'sqlite' && !includeMetadata ? ', priority as "__priority", created_on as "__createdOn"' : ''
      }
    `,
    values: params.values
  }
}

// Shared SET/WHERE body for marking jobs completed (no RETURNING). Used by the
// single-statement completeJobs() and the distributed completeJobsDistributed().
function completeJobsUpdate (c: Ctx, table: string, includeQueued?: boolean): string {
  const d = dial(c)
  return `UPDATE ${qn(c, table)}
      SET completed_on = ${d.now()},
        state = '${JOB_STATES.completed}',
        output = ${d.jsonParam('$3')},
        blocked = ${includeQueued ? 'false' : 'blocked'},
        pending_dependencies = ${includeQueued ? '0' : 'pending_dependencies'}
      WHERE name = $1
        AND ${d.inArrayParam('id', '$2', 'uuid[]')}
        AND ${includeQueued
          ? d.stateLt('state', JOB_STATES.completed)
          : `state = '${JOB_STATES.active}'`
        }`
}

// Shared dependency-unblocking fragments. Both consume a `decremented` CTE
// (child_name, child_id, n) that the caller defines, and are reused by the standard
// completeJobs() and the distributed decrementDependents().
function lockedChildrenCte (c: Ctx): string {
  return `locked_children AS (
      SELECT j.name, j.id, d.n
      FROM ${qn(c, 'job')} j
      JOIN decremented d ON d.child_name = j.name
        AND d.child_id = j.id
      WHERE j.blocked
      ORDER BY j.name, j.id
      ${dial(c).name === 'sqlite' ? '' : 'FOR UPDATE OF j'}
    )`
}

function unblockChildrenUpdate (c: Ctx): string {
  const d = dial(c)
  return `UPDATE ${d.updateAlias(qn(c, 'job'), 'j')}
      SET pending_dependencies = ${d.greatest('j.pending_dependencies - lc.n', '0')},
          blocked = ${d.greatest('j.pending_dependencies - lc.n', '0')} > 0
      FROM locked_children lc
      WHERE j.name = lc.name
        AND j.id = lc.id`
}

// Dependency unblocking is intentionally NOT done here. Completion is the hot path; chasing
// dependents inline (joining job_dependency and the partitioned job table) made completion
// scale with partition count (see issue #824). The background resolver (Navigator) handles
// unblocking out of band, driven by the job_i9 partial index.
export function completeJobs (c: Ctx, table: string, includeQueued?: boolean) {
  return `
    WITH results AS (
      ${completeJobsUpdate(c, table, includeQueued)}
      RETURNING 1
    )
    SELECT COUNT(*) FROM results
  `
}

// Per-job-output completion: each job's output is supplied via a JSON recordset ($2) and applied by
// id, so a batch can be completed with distinct outputs in a single statement. Mirrors completeJobs
// (only active jobs; same dependency-unblocking), but sources output from the input join.
export function completeJobsWithOutputs (c: Ctx, table: string) {
  return `
    WITH input AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    ),
    results AS (
      UPDATE ${qn(c, table)} j
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
export function completeJobsWithOutputsDistributed (c: Ctx, table: string) {
  const d = dial(c)

  // Output values arrive pre-serialized (mapCompletionDataArg), so the sqlite branch extracts
  // them as JSON text; unqualified RETURNING per the sqlite alias rules.
  const input = d.name === 'sqlite'
    ? "SELECT value ->> 'id' AS id, json_extract(value, '$.output') AS output FROM json_each($2)"
    : 'SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)'

  return `
    WITH input AS (
      ${input}
    )
    UPDATE ${d.updateAlias(qn(c, table), 'j')}
    SET completed_on = ${d.now()},
      state = '${JOB_STATES.completed}',
      output = i.output
    FROM input i
    WHERE j.name = $1
      AND j.id = i.id
      AND j.state = '${JOB_STATES.active}'
    RETURNING ${d.returningAlias('j')}id
  `
}

export function cancelJobs (c: Ctx, table: string) {
  const d = dial(c)
  const mutation = `UPDATE ${qn(c, table)}
      SET completed_on = ${d.now()},
        state = '${JOB_STATES.cancelled}'
      WHERE name = $1
        AND ${d.inArrayParam('id', '$2', 'uuid[]')}
        AND ${d.stateLt('state', JOB_STATES.completed)}
      RETURNING 1`

  return countMutation(c, mutation)
}

export function resumeJobs (c: Ctx, table: string) {
  const d = dial(c)
  const mutation = `UPDATE ${qn(c, table)}
      SET completed_on = NULL,
        state = '${JOB_STATES.created}'
      WHERE name = $1
        AND ${d.inArrayParam('id', '$2', 'uuid[]')}
        AND state = '${JOB_STATES.cancelled}'
      RETURNING 1`

  return countMutation(c, mutation)
}

interface InsertJobsOptions {
  table: string
  name: string
  returnId?: boolean
  notify?: boolean
}

export function insertJobs (c: Ctx, { table, name, returnId = true, notify = false }: InsertJobsOptions) {
  // notify never renders on sqlite — the profile sets noListenNotify, so #notifyEnabled is false.
  if (dial(c).name === 'sqlite') {
    return insertJobsSqlite(c, { table, name, returnId })
  }

  // When notify is enabled we always RETURN start_after so the wrapper below can gate
  // the NOTIFY on immediate availability, regardless of whether the caller wants ids.
  const returning = notify ? 'RETURNING id, start_after' : returnId ? 'RETURNING id' : ''

  const insert = `
    INSERT INTO ${qn(c, table)} (
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
    JOIN ${qn(c, 'queue')} q ON q.name = '${name}'
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
      SELECT pg_notify(${notifyChannelSql(c)}, '${name}')
      FROM ins WHERE start_after <= now() LIMIT 1
    )
    SELECT id FROM ins WHERE (SELECT count(*) FROM notified) ${comparator}
  `
}

// The sqlite rendering of insertJobs: json_each replaces json_to_recordset, epoch math
// replaces interval arithmetic, and the resolved start_after is normalized through strftime
// so every stored timestamp shares the fixed-width ISO shape (lexicographic = chronological).
// Relative interval strings are converted to numeric seconds in JS before binding (manager),
// so the non-Z branch only handles numbers.
function insertJobsSqlite (c: Ctx, { table, name, returnId = true }: InsertJobsOptions): string {
  const ts = (expr: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${expr}, 'unixepoch')`

  return `
    INSERT INTO ${qn(c, table)} (
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
      COALESCE(id, ${SQLITE_UUID_DEFAULT}) as id,
      '${name}' as name,
      data,
      COALESCE(priority, 0) as priority,
      j.start_after,
      "singletonKey",
      CASE
        WHEN "singletonSeconds" IS NOT NULL THEN ${ts('"singletonSeconds" * CAST((unixepoch(\'subsec\') + COALESCE("singletonOffset", 0)) / "singletonSeconds" AS INTEGER)')}
        ELSE NULL
        END as singleton_on,
      "groupId" as group_id,
      "groupTier" as group_tier,
      COALESCE("expireInSeconds", q.expire_seconds) as expire_seconds,
      COALESCE("deleteAfterSeconds", q.deletion_seconds) as deletion_seconds,
      ${ts('unixepoch(j.start_after, \'subsec\') + COALESCE("retentionSeconds", q.retention_seconds)')} as keep_until,
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
      SELECT x.*,
        CASE
          WHEN substr("startAfter", -1) = 'Z' THEN strftime('%Y-%m-%dT%H:%M:%fZ', "startAfter")
          ELSE ${ts('unixepoch(\'subsec\') + CAST(COALESCE("startAfter", \'0\') AS REAL)')}
          END as start_after
      FROM (
        SELECT
          value ->> 'id' as id,
          value ->> 'priority' as priority,
          json_extract(value, '$.data') as data,
          value ->> 'startAfter' as "startAfter",
          value ->> 'retryLimit' as "retryLimit",
          value ->> 'retryDelay' as "retryDelay",
          value ->> 'retryDelayMax' as "retryDelayMax",
          value ->> 'retryBackoff' as "retryBackoff",
          value ->> 'singletonKey' as "singletonKey",
          value ->> 'singletonSeconds' as "singletonSeconds",
          value ->> 'singletonOffset' as "singletonOffset",
          value ->> 'groupId' as "groupId",
          value ->> 'groupTier' as "groupTier",
          value ->> 'expireInSeconds' as "expireInSeconds",
          value ->> 'deleteAfterSeconds' as "deleteAfterSeconds",
          value ->> 'retentionSeconds' as "retentionSeconds",
          value ->> 'deadLetter' as "deadLetter",
          value ->> 'heartbeatSeconds' as "heartbeatSeconds",
          value ->> 'blocked' as blocked,
          value ->> 'blocking' as blocking,
          value ->> 'pendingDependencies' as "pendingDependencies"
        FROM json_each($1)
      ) x
    ) j
    JOIN ${qn(c, 'queue')} q ON q.name = '${name}'
    WHERE true
    ON CONFLICT DO NOTHING
    ${returnId ? 'RETURNING id' : ''}
  `
}

// Self-contained (parameter-less) insert for one queue's slice of a flow batch. The JSON
// payload is embedded directly so the whole flow can be sent as a single multi-statement
// round-trip regardless of db adapter. Guarded so a skipped row (ON CONFLICT) raises
// 'division by zero', aborting the surrounding transaction. The divisor references the
// row count so it isn't constant-folded at plan time.
export function insertFlowJobs (c: Ctx, { table, name }: { table: string, name: string }, jobs: unknown[]): string {
  const insert = insertJobs(c, { table, name, returnId: true })
    .replace('$1', () => serializeJsonParam(jobs))

  return `
    WITH ins AS (
      ${insert}
    )
    SELECT 1 / (CASE WHEN (SELECT count(*) FROM ins) = ${jobs.length} THEN 1 ELSE 0 END)
  `
}

export function failJobsById (c: Ctx, table: string) {
  const where = `name = $1 AND id = ANY($2::uuid[]) AND state < '${JOB_STATES.completed}'`
  const output = '$3::jsonb'

  return failJobs(c, table, where, output)
}

export function failJobsByTimeout (c: Ctx, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const where = `state = '${JOB_STATES.active}'
            AND (started_on + expire_seconds * interval '1s') < now()
            AND name = ANY(${serializeArrayParam(queues)})`

  const output = '\'{ "value": { "message": "job timed out" } }\'::jsonb'

  return locked(c, failJobs(c, table, where, output), table + 'failJobsByTimeout', noAdvisoryLocks)
}

export function failJobsByHeartbeat (c: Ctx, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const where = `state = '${JOB_STATES.active}'
            AND heartbeat_seconds IS NOT NULL
            AND (heartbeat_on + heartbeat_seconds * interval '1s') < now()
            AND name = ANY(${serializeArrayParam(queues)})`

  const output = '\'{ "value": { "message": "job heartbeat timeout" } }\'::jsonb'

  return locked(c, failJobs(c, table, where, output), table + 'failJobsByHeartbeat', noAdvisoryLocks)
}

export function touchJobs (c: Ctx, table: string) {
  const d = dial(c)
  const mutation = `UPDATE ${qn(c, table)}
      SET heartbeat_on = ${d.now()}
      WHERE name = $1
        AND ${d.inArrayParam('id', '$2', 'uuid[]')}
        AND state = '${JOB_STATES.active}'
      RETURNING 1`

  return countMutation(c, mutation, 'FROM')
}

function failJobs (c: Ctx, table: string, where: string, output: string) {
  return `
    WITH ${failJobsBody(c, table, where, output)}
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
function failJobsBody (c: Ctx, table: string, where: string, output: string, forceTerminal = false) {
  const state = forceTerminal
    ? `'${JOB_STATES.failed}'::${qn(c, 'job_state')}`
    : `CASE
          WHEN retry_count < retry_limit THEN '${JOB_STATES.retry}'::${qn(c, 'job_state')}
          ELSE '${JOB_STATES.failed}'::${qn(c, 'job_state')}
          END`
  const completedOn = forceTerminal
    ? 'now()'
    : 'CASE WHEN retry_count < retry_limit THEN NULL ELSE now() END'

  return `deleted_jobs AS (
      DELETE FROM ${qn(c, table)}
      WHERE ${where}
      RETURNING *
    ),
    retried_jobs AS (
      INSERT INTO ${qn(c, table)} (
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
               GREATEST(retry_delay, 1) * (
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
      INSERT INTO ${qn(c, table)} (
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
        '${JOB_STATES.failed}'::${qn(c, 'job_state')} as state,
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
      INSERT INTO ${qn(c, 'job')} (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
        expire_seconds, source_name, source_id, source_created_on, source_retry_count, singleton_key, heartbeat_seconds)
      SELECT
        r.dead_letter,
        r.data,
        r.output,
        q.retry_limit,
        q.retry_backoff,
        q.retry_delay,
        now() + q.retention_seconds * interval '1s',
        q.deletion_seconds,
        q.expire_seconds,
        r.name,
        r.id,
        r.created_on,
        r.retry_count,
        r.singleton_key,
        r.heartbeat_seconds
      FROM results r
        JOIN ${qn(c, 'queue')} q ON q.name = r.dead_letter
      WHERE state = '${JOB_STATES.failed}'
    )`
}

export function failJobsByIdWithOutputs (c: Ctx, table: string) {
  // Output is supplied per job via a JSON recordset ($2). `where` and the output expression both
  // reference the output_map CTE so each re-inserted job keeps its own output. Constant number of
  // statements regardless of batch size.
  const where = `name = $1 AND id IN (SELECT id FROM output_map) AND state < '${JOB_STATES.completed}'`
  const output = '(SELECT om.output FROM output_map om WHERE om.id = deleted_jobs.id)'

  return `
    WITH output_map AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    ),
    ${failJobsBody(c, table, where, output)}
    SELECT COUNT(*) FROM results
  `
}

// Like failJobsByIdWithOutputs, but fails every job terminally (forceTerminal) so it routes straight
// to the dead letter queue, bypassing remaining retries. Backs the perJobResults `deadletter` status.
export function deadLetterJobsByIdWithOutputs (c: Ctx, table: string) {
  const where = `name = $1 AND id IN (SELECT id FROM output_map) AND state < '${JOB_STATES.completed}'`
  const output = '(SELECT om.output FROM output_map om WHERE om.id = deleted_jobs.id)'

  return `
    WITH output_map AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    ),
    ${failJobsBody(c, table, where, output, true)}
    SELECT COUNT(*) FROM results
  `
}

// Distributed mode: separate queries to avoid CockroachDB's multi-mutation CTE limitation
export function selectJobsToFailById (c: Ctx, table: string): SqlQuery {
  const d = dial(c)
  return {
    text: `SELECT * FROM ${qn(c, table)} WHERE name = $1 AND ${d.inArrayParam('id', '$2', 'uuid[]')} AND ${d.stateLt('state', JOB_STATES.completed)}`,
    values: []
  }
}

export function deleteJobsToFail (c: Ctx, table: string): SqlQuery {
  return {
    text: `DELETE FROM ${qn(c, table)} WHERE name = $1 AND ${dial(c).inArrayParam('id', '$2', 'uuid[]')}`,
    values: []
  }
}

// Distributed mode: the predicate-based maintenance expiry equivalents of selectJobsToFailById.
// The supervisor's failJobsByTimeout/failJobsByHeartbeat use the multi-mutation failJobs() CTE,
// which CockroachDB rejects, so in distributed mode we select the timed-out jobs here and re-insert
// them separately (delete via deleteJobsByIds, re-insert via insertRetryJob), all in one transaction.
export function selectJobsToFailByTimeout (c: Ctx, table: string, queues: string[]): SqlQuery {
  return {
    text: `SELECT * FROM ${qn(c, table)}
      WHERE state = '${JOB_STATES.active}'
        AND (${dial(c).tsPlusSeconds('started_on', 'expire_seconds')}) < ${dial(c).now()}
        AND ${dial(c).inArrayLiteral('name', queues)}`,
    values: []
  }
}

export function selectJobsToFailByHeartbeat (c: Ctx, table: string, queues: string[]): SqlQuery {
  return {
    text: `SELECT * FROM ${qn(c, table)}
      WHERE state = '${JOB_STATES.active}'
        AND heartbeat_seconds IS NOT NULL
        AND (${dial(c).tsPlusSeconds('heartbeat_on', 'heartbeat_seconds')}) < ${dial(c).now()}
        AND ${dial(c).inArrayLiteral('name', queues)}`,
    values: []
  }
}

export function deleteJobsByIds (c: Ctx, table: string): SqlQuery {
  return {
    text: `DELETE FROM ${qn(c, table)} WHERE ${dial(c).inArrayParam('id', '$1', 'uuid[]')}`,
    values: []
  }
}

// Distributed mode: complete jobs as a single-table mutation. Dependency unblocking is handled
// out of band by the background resolver (Navigator), so completion does no dependency work.
export function completeJobsDistributed (c: Ctx, table: string, includeQueued?: boolean): string {
  return `
    ${completeJobsUpdate(c, table, includeQueued)}
    RETURNING id
  `
}

// Decrement pending_dependencies for children of the given completed parent jobs, unblocking
// any that reach zero. Only the final UPDATE mutates job, so this is a single mutation acceptable
// to CockroachDB. Used by the distributed flow resolver path. $1 is the parent queue name, $2 the
// list of resolved parent ids for that queue.
export function decrementDependents (c: Ctx): string {
  return `
    WITH decremented AS (
      SELECT d.child_name, d.child_id, ${dial(c).castInt('COUNT(*)')} AS n
      FROM ${qn(c, 'job_dependency')} d
      WHERE d.parent_name = $1
        AND ${dial(c).inArrayParam('d.parent_id', '$2', 'uuid[]')}
      GROUP BY d.child_name, d.child_id
    ),
    ${lockedChildrenCte(c)}
    ${unblockChildrenUpdate(c)}
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
export function resolveFlowJobs (c: Ctx, table: string, names: string[]): SqlQuery {
  return {
    text: `
    WITH locked_parents AS (
      SELECT j.name, j.id
      FROM ${qn(c, table)} j
      WHERE j.blocking
        AND j.state = '${JOB_STATES.completed}'
        AND j.name = ANY($1::text[])
      ORDER BY j.name, j.id
      FOR UPDATE OF j SKIP LOCKED
      LIMIT ${FLOW_BATCH_SIZE}
    ),
    decremented AS (
      SELECT d.child_name, d.child_id, COUNT(*)::int AS n
      FROM ${qn(c, 'job_dependency')} d
      JOIN locked_parents p ON d.parent_name = p.name
        AND d.parent_id = p.id
      GROUP BY d.child_name, d.child_id
    ),
    ${lockedChildrenCte(c)},
    unblocked AS (
      ${unblockChildrenUpdate(c)}
      RETURNING 1
    ),
    cleared AS (
      UPDATE ${qn(c, table)} j
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
export function selectBlockingParents (c: Ctx, table: string, names: string[], noSkipLocked?: boolean): SqlQuery {
  return {
    text: `
      SELECT name, id
      FROM ${qn(c, table)}
      WHERE blocking
        AND state = '${JOB_STATES.completed}'
        AND ${dial(c).inArrayParam('name', '$1', 'text[]')}
      ORDER BY name, id
      ${dial(c).name === 'sqlite' ? '' : `FOR UPDATE${noSkipLocked ? '' : ' SKIP LOCKED'}`}
      LIMIT ${FLOW_BATCH_SIZE}
    `,
    values: [names]
  }
}

// Distributed flow audit: clear `blocking` on resolved parents (single mutation). $1 is the parent
// queue name, $2 the list of resolved parent ids for that queue.
export function clearBlocking (c: Ctx): string {
  return `
    UPDATE ${qn(c, 'job')}
    SET blocking = false
    WHERE name = $1
      AND ${dial(c).inArrayParam('id', '$2', 'uuid[]')}
  `
}

export function insertRetryJob (c: Ctx, table: string): string {
  return `
    INSERT INTO ${qn(c, table)} (
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

export function insertDeadLetterJob (c: Ctx): string {
  return `
    INSERT INTO ${qn(c, 'job')} (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
      expire_seconds, source_name, source_id, source_created_on, source_retry_count, singleton_key, heartbeat_seconds)
    SELECT $1, $2, $3, q.retry_limit, q.retry_backoff, q.retry_delay, ${dial(c).nowPlusSeconds('q.retention_seconds')}, q.deletion_seconds,
      q.expire_seconds, $4, $5, $6, $7, $8, $9
    FROM ${qn(c, 'queue')} q WHERE q.name = $1
  `
}

// The sqlite redrive is a manager-side split (SQLite forbids DML in CTEs): select candidates,
// delete them, re-insert per job. The JOIN mirrors redriveJobs' candidates CTE so orphaned jobs
// (no destination queue) are never deleted.
export function selectJobsToRedrive (c: Ctx, table: string): SqlQuery {
  const d = dial(c)
  return {
    text: `
      SELECT j.id, j.data, j.priority, j.singleton_key as "singletonKey",
        j.heartbeat_seconds as "heartbeatSeconds", j.source_name as "sourceName"
      FROM ${qn(c, table)} j
      JOIN ${qn(c, 'queue')} q ON q.name = COALESCE($2, j.source_name)
      WHERE j.name = $1
        AND ${d.stateLt('j.state', JOB_STATES.active)}
        AND (${d.textParamIsNull('$3')} OR j.source_name = $3)
      ORDER BY j.created_on
      LIMIT $4
    `,
    values: []
  }
}

// Re-creates one redriven job on its destination queue, deriving retry/retention/policy config
// from the queue row — the per-row equivalent of redriveJobs' ins CTE, including the ON CONFLICT
// DO NOTHING drop semantics for singleton collisions.
export function insertRedriveJob (c: Ctx): string {
  return `
    INSERT INTO ${qn(c, 'job')}
      (name, data, priority, retry_limit, retry_backoff, retry_delay, retry_delay_max,
       expire_seconds, keep_until, deletion_seconds, policy, singleton_key, heartbeat_seconds)
    SELECT q.name, $2, $3, q.retry_limit, q.retry_backoff, q.retry_delay, q.retry_delay_max,
      q.expire_seconds, ${dial(c).nowPlusSeconds('q.retention_seconds')}, q.deletion_seconds, q.policy, $4, $5
    FROM ${qn(c, 'queue')} q WHERE q.name = $1
    ON CONFLICT DO NOTHING
    RETURNING id
  `
}

// Dead-letter redrive. Moves un-started jobs out of a dead-letter queue and
// re-creates them as fresh jobs on their original source queue (or $2 destination override),
// oldest-first, capped at $4. The JOIN in `candidates` only matches jobs whose destination queue
// exists, so legacy/orphaned jobs (NULL source_name, no override) are never deleted — they stay
// in the DLQ rather than being lost. Re-created jobs get a new id, `created` state, retry_count 0,
// cleared output, NULL source_*, and the destination queue's current retry/retention/policy config.
export function redriveJobs (c: Ctx, table: string): string {
  return `
    WITH candidates AS (
      SELECT j.id
      FROM ${qn(c, table)} j
      JOIN ${qn(c, 'queue')} q ON q.name = COALESCE($2, j.source_name)
      WHERE j.name = $1
        AND j.state < '${JOB_STATES.active}'
        AND ($3::text IS NULL OR j.source_name = $3)
      ORDER BY j.created_on
      LIMIT $4
      FOR UPDATE OF j SKIP LOCKED
    ),
    moved AS (
      DELETE FROM ${qn(c, table)}
      WHERE id IN (SELECT id FROM candidates)
      RETURNING *
    ),
    ins AS (
      INSERT INTO ${qn(c, 'job')}
        (name, data, priority, retry_limit, retry_backoff, retry_delay, retry_delay_max,
         expire_seconds, keep_until, deletion_seconds, policy, singleton_key, heartbeat_seconds)
      SELECT COALESCE($2, m.source_name), m.data, m.priority, q.retry_limit, q.retry_backoff,
        q.retry_delay, q.retry_delay_max, q.expire_seconds,
        now() + q.retention_seconds * interval '1s', q.deletion_seconds, q.policy,
        m.singleton_key, m.heartbeat_seconds
      FROM moved m JOIN ${qn(c, 'queue')} q ON q.name = COALESCE($2, m.source_name)
      -- A destination queue's short/stately policy can still collide on (name, singleton_key)
      -- if two redriven jobs share a key (job_i1/job_i3); dropping just that row here, matching
      -- retried_jobs' ON CONFLICT DO NOTHING elsewhere, is preferable to aborting the whole batch.
      -- The dropped job has already been deleted from the DLQ by the moved CTE and is not restored.
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS moved FROM ins
  `
}

export function deletion (c: Ctx, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const d = dial(c)
  const sql = `
    DELETE FROM ${qn(c, table)}
    WHERE ${d.inArrayLiteral('name', queues)}
      AND
      (
        (deletion_seconds > 0 AND ${d.tsPlusSeconds('completed_on', 'deletion_seconds')} < ${d.now()})
        OR
        (${d.stateLt('state', JOB_STATES.active)} AND keep_until < ${d.now()})
      )
  `

  return locked(c, sql, table + 'deletion', noAdvisoryLocks)
}

export function retryJobs (c: Ctx, table: string) {
  const d = dial(c)
  const mutation = `UPDATE ${qn(c, 'job')}
      SET state = '${JOB_STATES.retry}',
        retry_limit = retry_limit + 1,
        completed_on = NULL
      WHERE name = $1
        AND ${d.inArrayParam('id', '$2', 'uuid[]')}
        AND state = '${JOB_STATES.failed}'
      RETURNING 1`

  return countMutation(c, mutation)
}

// Partial in-place edit of not-yet-active jobs, preserving id/state/singleton identity.
// The payload ($1) is a jsonb object of ONLY the fields the caller supplied; each column is
// left untouched unless its key is present (`jsonb_exists(o.data, 'key')`), so an update that carries just
// `data` never clobbers an existing start_after/priority/etc. Targeting is by id or
// singleton_key; when by key, `match` picks which of several pre-active matches to edit
// (newest/oldest = one row via ORDER BY + LIMIT; all = every match). When `notify` is set the
// edit emits a single pg_notify iff a touched row ends up runnable (start_after <= now()),
// closing the wake-up gap for jobs pulled forward. Callers needing insert-on-miss compose this
// with insertJobs (see Manager.upsert).
export function updateJob (c: Ctx, table: string, name: string, by: 'id' | 'singletonKey', match: JobMatchStrategy, notify = false) {
  // notify never renders on sqlite — the profile sets noListenNotify.
  if (dial(c).name === 'sqlite') {
    return updateJobSqlite(c, table, name, by, match)
  }

  const targetPredicate = by === 'id'
    ? "job.id = (o.data->>'id')::uuid"
    : "job.singleton_key = o.data->>'singletonKey'"
  const ordering = (by === 'singletonKey' && match !== 'all')
    ? `ORDER BY job.created_on ${match === 'oldest' ? 'ASC' : 'DESC'} LIMIT 1`
    : ''

  // Resolve the incoming startAfter the same way insertJobs does (absolute 'Z' timestamp vs.
  // relative interval), falling back to the row's current start_after when not supplied.
  const resolvedStartAfter = `
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END`

  const tail = notify
    ? `, notified AS (
      SELECT pg_notify(${notifyChannelSql(c)}, '${name}')
      FROM upd WHERE start_after <= now() LIMIT 1
    )
    SELECT id FROM upd WHERE (SELECT count(*) FROM notified) >= 0`
    : `
    SELECT id FROM upd`

  return `
    WITH o AS (SELECT $1::jsonb AS data),
    target AS (
      SELECT job.id
      FROM ${qn(c, table)} job, o
      WHERE job.name = '${name}'
        AND job.state < '${JOB_STATES.active}'
        AND ${targetPredicate}
      ${ordering}
    ),
    upd AS (
      UPDATE ${qn(c, table)} job
      SET data = CASE WHEN jsonb_exists(o.data, 'data') THEN o.data->'data' ELSE job.data END,
          priority = COALESCE((o.data->>'priority')::int, job.priority),
          start_after = ${resolvedStartAfter},
          keep_until = CASE
            WHEN jsonb_exists(o.data, 'retentionSeconds')
              THEN (${resolvedStartAfter}) + ((o.data->>'retentionSeconds')::int * interval '1s')
            -- When only start_after moves, slide keep_until by the same original retention window
            -- (keep_until - start_after) so pulling a job forward/back never leaves keep_until in
            -- the past, which the deletion sweep would treat as expired and remove the pending job.
            WHEN jsonb_exists(o.data, 'startAfter')
              THEN (${resolvedStartAfter}) + (job.keep_until - job.start_after)
            ELSE job.keep_until END,
          expire_seconds = COALESCE((o.data->>'expireInSeconds')::int, job.expire_seconds),
          deletion_seconds = COALESCE((o.data->>'deleteAfterSeconds')::int, job.deletion_seconds),
          retry_limit = COALESCE((o.data->>'retryLimit')::int, job.retry_limit),
          retry_delay = COALESCE((o.data->>'retryDelay')::int, job.retry_delay),
          retry_backoff = COALESCE((o.data->>'retryBackoff')::bool, job.retry_backoff),
          retry_delay_max = CASE WHEN jsonb_exists(o.data, 'retryDelayMax') THEN (o.data->>'retryDelayMax')::int ELSE job.retry_delay_max END,
          dead_letter = CASE WHEN jsonb_exists(o.data, 'deadLetter') THEN o.data->>'deadLetter' ELSE job.dead_letter END,
          heartbeat_seconds = CASE WHEN jsonb_exists(o.data, 'heartbeatSeconds') THEN (o.data->>'heartbeatSeconds')::int ELSE job.heartbeat_seconds END,
          group_id = CASE WHEN jsonb_exists(o.data, 'groupId') THEN o.data->>'groupId' ELSE job.group_id END,
          group_tier = CASE WHEN jsonb_exists(o.data, 'groupTier') THEN o.data->>'groupTier' ELSE job.group_tier END
      FROM o
      -- Re-check state < active on the locked row, not just in the unlocked target CTE. Under
      -- READ COMMITTED a concurrent fetchNextJob can activate a candidate between target selection
      -- and this UPDATE; EvalPlanQual re-evaluates this predicate on the freshly-locked row, so the
      -- guard here prevents mutating a job a worker has already started running.
      WHERE job.id IN (SELECT id FROM target)
        AND job.state < '${JOB_STATES.active}'
      RETURNING job.id, job.start_after
    )${tail}
  `
}

// The sqlite rendering of updateJob: SELECT-only CTEs feed a top-level UPDATE (SQLite forbids DML
// in CTEs), json functions replace jsonb operators, epoch math replaces interval arithmetic, and
// RETURNING columns are unqualified. Relative startAfter strings arrive pre-converted to numeric
// seconds (manager #normalizeStartAfter).
function updateJobSqlite (c: Ctx, table: string, name: string, by: 'id' | 'singletonKey', match: JobMatchStrategy): string {
  const d = dial(c)
  const has = (key: string) => d.jsonHasKey('o.data', key)
  const get = (key: string) => `o.data ->> '${key}'`
  const ts = (expr: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${expr}, 'unixepoch')`

  const targetPredicate = by === 'id'
    ? `job.id = ${get('id')}`
    : `job.singleton_key = ${get('singletonKey')}`
  const ordering = (by === 'singletonKey' && match !== 'all')
    ? `ORDER BY job.created_on ${match === 'oldest' ? 'ASC' : 'DESC'} LIMIT 1`
    : ''

  const resolvedStartAfter = `
        CASE WHEN ${has('startAfter')}
          THEN CASE WHEN substr(${get('startAfter')}, -1) = 'Z'
                 THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${get('startAfter')})
                 ELSE ${ts(`unixepoch('subsec') + CAST(${get('startAfter')} AS REAL)`)} END
          ELSE job.start_after END`

  return `
    WITH o AS (SELECT $1 AS data),
    target AS (
      SELECT job.id
      FROM ${qn(c, table)} job, o
      WHERE job.name = '${name}'
        AND ${d.stateLt('job.state', JOB_STATES.active)}
        AND ${targetPredicate}
      ${ordering}
    )
    UPDATE ${qn(c, table)} AS job
    SET data = CASE WHEN ${has('data')} THEN o.data -> 'data' ELSE job.data END,
        priority = COALESCE(${get('priority')}, job.priority),
        start_after = ${resolvedStartAfter},
        keep_until = CASE
          WHEN ${has('retentionSeconds')}
            THEN ${ts(`unixepoch((${resolvedStartAfter}), 'subsec') + (${get('retentionSeconds')})`)}
          WHEN ${has('startAfter')}
            THEN ${ts(`unixepoch((${resolvedStartAfter}), 'subsec') + (unixepoch(job.keep_until, 'subsec') - unixepoch(job.start_after, 'subsec'))`)}
          ELSE job.keep_until END,
        expire_seconds = COALESCE(${get('expireInSeconds')}, job.expire_seconds),
        deletion_seconds = COALESCE(${get('deleteAfterSeconds')}, job.deletion_seconds),
        retry_limit = COALESCE(${get('retryLimit')}, job.retry_limit),
        retry_delay = COALESCE(${get('retryDelay')}, job.retry_delay),
        retry_backoff = COALESCE(${get('retryBackoff')}, job.retry_backoff),
        retry_delay_max = CASE WHEN ${has('retryDelayMax')} THEN ${get('retryDelayMax')} ELSE job.retry_delay_max END,
        dead_letter = CASE WHEN ${has('deadLetter')} THEN ${get('deadLetter')} ELSE job.dead_letter END,
        heartbeat_seconds = CASE WHEN ${has('heartbeatSeconds')} THEN ${get('heartbeatSeconds')} ELSE job.heartbeat_seconds END,
        group_id = CASE WHEN ${has('groupId')} THEN ${get('groupId')} ELSE job.group_id END,
        group_tier = CASE WHEN ${has('groupTier')} THEN ${get('groupTier')} ELSE job.group_tier END
    FROM o
    WHERE job.id IN (SELECT id FROM target)
      AND ${d.stateLt('job.state', JOB_STATES.active)}
    RETURNING id
  `
}

// With embedQueues, the queue-name filter is rendered as a literal list (queue names are
// attorney-validated identifiers) so the statement is parameter-free and can be inlined into
// multi-statement maintenance scripts on both dialects.
export function getQueueStats (c: Ctx, table: string, queues: string[], embedQueues = false): SqlQuery {
  const d = dial(c)
  const nameFilter = embedQueues
    ? d.name === 'sqlite'
      ? `name IN (${queues.map(q => sqliteLiteral(q)).join(',')})`
      : `name = ANY(${serializeArrayParam(queues)})`
    : d.inArrayParam('name', '$1', 'text[]')

  // json_group_array yields '[]' over zero matching rows where array_agg yields NULL — nullif
  // keeps the singletonsActive shape (string[] | null) identical across backends.
  const singletonsAgg = `${d.arrayAgg('singleton_key')} FILTER (WHERE policy IN ('${QUEUE_POLICIES.singleton}','${QUEUE_POLICIES.stately}') AND state = '${JOB_STATES.active}')`
  const singletonsActive = d.name === 'sqlite' ? `nullif(${singletonsAgg}, '[]')` : singletonsAgg

  return {
    text: `
    SELECT
        name,
        "deferredCount",
        "queuedCount",
        ${d.greatest('"queuedCount" - "deferredCount"', '0')} as "readyCount",
        "activeCount",
        "failedCount",
        "totalCount",
        "singletonsActive"
      FROM (
        SELECT
            name,
            ${d.castInt(`(count(*) FILTER (WHERE start_after > ${d.now()} AND ${d.stateLt('state', JOB_STATES.active)}))`)} as "deferredCount",
            ${d.castInt(`(count(*) FILTER (WHERE ${d.stateLt('state', JOB_STATES.active)}))`)} as "queuedCount",
            ${d.castInt(`(count(*) FILTER (WHERE state = '${JOB_STATES.active}'))`)} as "activeCount",
            ${d.castInt(`(count(*) FILTER (WHERE state = '${JOB_STATES.failed}'))`)} as "failedCount",
            ${d.castInt('count(*)')} as "totalCount",
            ${singletonsActive} as "singletonsActive"
          FROM ${qn(c, table)}
          WHERE ${nameFilter}
          GROUP BY 1
      ) stats
  `,
    values: embedQueues ? [] : [queues]
  }
}

// Length of the recent-ready-count sliding window kept on queue.ready_history for the dashboard
// sparkline. One sample is appended per monitor cycle (default 60s), so this is roughly the last
// READY_HISTORY_SIZE minutes of trend. Sized to comfortably render the sparkline (the widest is the
// ~160px detail card) without over-collecting — more points than pixels add nothing visible.
export const READY_HISTORY_SIZE = 60

export function cacheQueueStats (c: Ctx, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  if (dial(c).name === 'sqlite') {
    return cacheQueueStatsSqlite(c, table, queues, noAdvisoryLocks)
  }

  const statsQuery = getQueueStats(c, table, queues)
  // Serialize the $1 parameter for use in locked() multi-statement query
  const statsText = statsQuery.text.replace('$1::text[]', serializeArrayParam(queues))

  const sql = `
    WITH stats AS (${statsText})
    UPDATE ${qn(c, 'queue')} SET
      deferred_count = COALESCE(stats."deferredCount", 0),
      queued_count = COALESCE(stats."queuedCount", 0),
      ready_count = COALESCE(stats."readyCount", 0),
      active_count = COALESCE(stats."activeCount", 0),
      failed_count = COALESCE(stats."failedCount", 0),
      total_count = COALESCE(stats."totalCount", 0),
      singletons_active = stats."singletonsActive",
      -- Always-on sliding window of recent ready counts for the dashboard sparkline. Prepend the
      -- newest sample and keep the newest READY_HISTORY_SIZE, stored newest-first. Built with
      -- unnest + array_agg (not array slicing, which some distributed engines lack).
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

  return locked(c, sql, 'queue-stats', noAdvisoryLocks)
}

// The sqlite rendering of cacheQueueStats: json arrays replace int[]/unnest for the ready_history
// window (json_each's key is the ordinal; the fresh sample sorts first as -1), the UPDATE target
// carries an explicit alias, and RETURNING columns are unqualified. Statement stays parameter-free
// so it can ride in the locked() maintenance script.
function cacheQueueStatsSqlite (c: Ctx, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const statsText = getQueueStats(c, table, queues, true).text
  const namesTable = queues.map(q => `SELECT ${sqliteLiteral(q)} as name`).join(' UNION ALL ')

  const sql = `
    WITH stats AS (${statsText})
    UPDATE ${qn(c, 'queue')} AS queue SET
      deferred_count = COALESCE(stats."deferredCount", 0),
      queued_count = COALESCE(stats."queuedCount", 0),
      ready_count = COALESCE(stats."readyCount", 0),
      active_count = COALESCE(stats."activeCount", 0),
      failed_count = COALESCE(stats."failedCount", 0),
      total_count = COALESCE(stats."totalCount", 0),
      singletons_active = stats."singletonsActive",
      ready_history = (
        SELECT COALESCE(json_group_array(v ORDER BY ord), '[]')
        FROM (
          SELECT v, ord
          FROM (
            SELECT COALESCE(stats."readyCount", 0) AS v, -1 AS ord
            UNION ALL
            SELECT je.value AS v, je.key AS ord
            FROM json_each(COALESCE(queue.ready_history, '[]')) je
          ) merged
          ORDER BY ord
          LIMIT ${READY_HISTORY_SIZE}
        ) capped
      )
    FROM (
      ${namesTable}
    ) q
    LEFT JOIN stats ON stats.name = q.name
    WHERE queue.name = q.name
    RETURNING
      name,
      queued_count as "queuedCount",
      warning_queued as "warningQueueSize"
  `

  return locked(c, sql, 'queue-stats', noAdvisoryLocks)
}

// Recompute one queue's counts from the job table and write them back to the queue-table cache
// (including monitor_on, so subsequent reads are served from cache), returning the fresh counts.
// Backs getQueueStats(name, { force: true }) and the first read of a never-monitored queue. A single
// atomic UPDATE ... RETURNING — no advisory lock needed since concurrent forced refreshes are
// idempotent (each is a valid point-in-time snapshot; last write wins).
export function refreshQueueStats (c: Ctx, table: string, name: string): string {
  const d = dial(c)
  const statsText = getQueueStats(c, table, [name], true).text

  // SQLite: no unnest (a literal VALUES-style SELECT serves as the name table), the UPDATE
  // target needs an explicit alias for the qualified references, and RETURNING rejects
  // alias-qualified columns.
  const namesTable = d.name === 'sqlite'
    ? `SELECT ${sqliteLiteral(name)} as name`
    : `SELECT q.name
      FROM unnest(${serializeArrayParam([name])}) AS q(name)`
  const target = d.name === 'sqlite' ? `${qn(c, 'queue')} AS queue` : qn(c, 'queue')
  const rq = d.name === 'sqlite' ? '' : 'queue.'

  return `
    WITH stats AS (${statsText})
    UPDATE ${target} SET
      deferred_count = COALESCE(stats."deferredCount", 0),
      queued_count = COALESCE(stats."queuedCount", 0),
      ready_count = COALESCE(stats."readyCount", 0),
      active_count = COALESCE(stats."activeCount", 0),
      failed_count = COALESCE(stats."failedCount", 0),
      total_count = COALESCE(stats."totalCount", 0),
      singletons_active = stats."singletonsActive",
      monitor_on = ${d.now()}
    FROM (
      ${namesTable}
    ) q
    LEFT JOIN stats ON stats.name = q.name
    WHERE queue.name = q.name
    RETURNING
      ${rq}name,
      ${rq}deferred_count as "deferredCount",
      ${rq}queued_count as "queuedCount",
      ${rq}ready_count as "readyCount",
      ${rq}active_count as "activeCount",
      ${rq}failed_count as "failedCount",
      ${rq}total_count as "totalCount",
      ${rq}monitor_on as "capturedOn"
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

export function transaction (c: Ctx, query: string | string[]): string {
  const sql = Array.isArray(query) ? query.join(';\n') : query

  return dial(c).transaction(sql)
}

export function locked (c: Ctx, query: string | string[], key?: string, noAdvisoryLocks?: boolean): string {
  const statements = Array.isArray(query) ? query : [query]
  return transaction(c, noAdvisoryLocks ? statements : [advisoryLock(c, key), ...statements])
}

// normalizeSchemaName, not resolveSchemaName: the key is opaque to postgres and never compared
// against the catalog, so it only has to agree across instances on the same schema. See the note
// on the helper.
function advisoryLock (c: Ctx, key?: string) {
  return `SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.${normalizeSchemaName(sch(c))}${key || ''}')::bytea), 'hex'))::bit(64)::bigint
  )`
}

export function findJobs (c: Ctx, table: string, options: { queued: boolean, byKey: boolean, byData: boolean, byId: boolean }) {
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
    whereConditions.push(dial(c).name === 'sqlite'
      // Shallow containment: every top-level key/value in the param must match. Nested objects
      // compare as JSON text.
      ? `AND NOT EXISTS (SELECT 1 FROM json_each($${paramIndex}) p WHERE json_extract(data, '$.' || p.key) IS NOT p.value)`
      : `AND data @> $${paramIndex}`)
  }

  if (queued) {
    whereConditions.push(`AND ${dial(c).stateLt('state', JOB_STATES.active)}`)
  }

  return `
    SELECT ${JOB_COLUMNS_ALL}
    FROM ${qn(c, table)}
    WHERE name = $1
      ${whereConditions.join('\n      ')}
    `
}

export function getJobById (c: Ctx, table: string) {
  return `
    SELECT ${JOB_COLUMNS_ALL}
    FROM ${qn(c, table)}
    WHERE name = $1
      AND id = $2
    `
}

// Pass `deps` to embed the payload as a literal (parameter-less) so the statement can be
// concatenated into a flow batch; omit it to get the parameterized ($1) form.
export function insertDependencies (c: Ctx, deps?: unknown[]) {
  // The embedded-literal form is postgres-only (flow batches); sqlite flows bind the payload.
  if (dial(c).name === 'sqlite') {
    return `
    INSERT INTO ${qn(c, 'job_dependency')} (child_name, child_id, parent_name, parent_id)
    SELECT value ->> 'child_name', value ->> 'child_id', value ->> 'parent_name', value ->> 'parent_id'
    FROM json_each($1)
    WHERE true
    ON CONFLICT DO NOTHING
  `
  }

  const sql = `
    INSERT INTO ${qn(c, 'job_dependency')} (child_name, child_id, parent_name, parent_id)
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

export function getDependencies (c: Ctx) {
  return `
    SELECT parent_name as "parentName", parent_id as "parentId"
    FROM ${qn(c, 'job_dependency')}
    WHERE child_name = $1 AND child_id = $2
  `
}

export function getDependents (c: Ctx) {
  return `
    SELECT child_name as "childName", child_id as "childId"
    FROM ${qn(c, 'job_dependency')}
    WHERE parent_name = $1 AND parent_id = $2
  `
}

export function cleanupDependencies (c: Ctx, table: string, queues: string[], noAdvisoryLocks?: boolean): string {
  const sql = `
    DELETE FROM ${qn(c, 'job_dependency')}
    WHERE (${dial(c).inArrayLiteral('child_name', queues)}
      AND NOT EXISTS (
        SELECT 1 FROM ${qn(c, table)} j
        WHERE j.name = child_name AND j.id = child_id
      ))
    OR (${dial(c).inArrayLiteral('parent_name', queues)}
      AND NOT EXISTS (
        SELECT 1 FROM ${qn(c, table)} j
        WHERE j.name = parent_name AND j.id = parent_id
      ))
  `

  return locked(c, sql, table + 'cleanupDependencies', noAdvisoryLocks)
}
