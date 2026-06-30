import assert from 'node:assert'
import * as plans from './plans.ts'
import * as types from './types.ts'

// Options for rendering an async (BAM) migration as inline, self-contained DDL instead
// of a job_table_run_async() enqueue call. Used by CLI / exported migrations, which run
// in a context with no BAM worker to process the queued commands. See issue #766.
interface MigrateOptions {
  inlineAsync?: boolean
  // Partitioned queue table names to expand the inlined index builds across, in addition
  // to job_common. Supplied by callers that hold a live connection (the CLI); empty for a
  // purely static export, which can only target job_common.
  partitionTables?: string[]
}

// Mirrors the SQL job_table_format() function (src/plans.ts): rewrites a command targeting
// the base `job` table to target a specific partition table.
function formatJobTable (command: string, table: string) {
  return command
    .replaceAll('.job', `.${table}`)
    .replaceAll('job_i', `${table}_i`)
}

// Derives the direct index DDL that a job_table_run_async() command would eventually run
// via BAM, one statement per target table, each prefixed with a provenance comment. The
// CONCURRENTLY keyword is preserved (these are emitted after COMMIT), and IF NOT EXISTS is
// added so the script is safe to re-run.
function inlineAsyncCommand (schema: string, asyncCommand: string, version: number, partitionTables: string[]) {
  const nameMatch = asyncCommand.match(/job_table_run_async\(\s*'([^']+)'/)
  const bodyMatch = asyncCommand.match(/\$\$([\s\S]*?)\$\$/)
  // An explicit table arg after the $$ body pins the command to a single table (e.g. i8 →
  // job_common); without it the command fans out across job_common + every partition.
  const tableMatch = asyncCommand.match(/\$\$\s*,\s*'([^']+)'/)

  assert(nameMatch && bodyMatch, `Unable to inline async migration command: ${asyncCommand}`)

  const commandName = nameMatch[1]
  const body = bodyMatch[1].trim()
  const targetTables = tableMatch ? [tableMatch[1]] : ['job_common', ...partitionTables]

  return targetTables.map(table => {
    // Add IF NOT EXISTS so the exported script is re-runnable. The negative lookahead keeps it
    // idempotent when the async command already spells out IF NOT EXISTS (the live BAM path needs it
    // there for its own idempotency — e.g. migration v36's job_i9 build), avoiding a double insert.
    const ddl = formatJobTable(body, table).replace(
      /(CREATE (?:UNIQUE )?INDEX CONCURRENTLY)(?! IF NOT EXISTS) /,
      '$1 IF NOT EXISTS '
    )
    const comment = `-- inlined from ${schema}.job_table_run_async (migration v${version}, command: ${commandName})`
    return `${comment}\n${ddl}`
  })
}

// A migration split into its transactional block and the post-COMMIT CONCURRENTLY index
// builds. The concurrent statements cannot run inside a transaction, so a programmatic
// caller (the CLI apply path) must execute each one on its own; a printed script can simply
// concatenate them (psql runs top-level statements individually). See migrate().
interface MigrationCommands {
  sql: string
  concurrent: string[]
}

function flatten (schema: string, commands: string[], version: number, noAdvisoryLocks?: boolean) {
  commands.unshift(plans.assertMigration(schema, version))
  commands.push(plans.setVersion(schema, version))

  return plans.locked(schema, commands, undefined, noAdvisoryLocks)
}

function rollback (schema: string, version: number, migrations?: types.Migration[], noAdvisoryLocks?: boolean) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.version === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.uninstall || [], result.previous, noAdvisoryLocks)
}

function next (schema: string, version: number, migrations?: types.Migration[], noAdvisoryLocks?: boolean) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.previous === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version, noAdvisoryLocks)
}

// Builds the migration as separate pieces: the transactional block plus any inlined
// CONCURRENTLY index builds (when options.inlineAsync). Callers that execute SQL
// programmatically must run `concurrent` statements individually, outside a transaction.
function migrateCommands (schema: string, version: number, migrations?: types.Migration[], noAdvisoryLocks?: boolean, options: MigrateOptions = {}): MigrationCommands {
  migrations = migrations || getAll(schema)

  const concurrent: string[] = []

  const result = migrations
    .filter(i => i.previous >= version!)
    .sort((a, b) => a.version - b.version)
    .reduce((acc, migration) => {
      acc.install = acc.install.concat(migration.install)

      if (migration.async) {
        if (options.inlineAsync) {
          // Bypass BAM: emit the real index DDL (run after COMMIT) instead of enqueuing it.
          for (const cmd of migration.async) {
            concurrent.push(...inlineAsyncCommand(schema, cmd, migration.version, options.partitionTables || []))
          }
        } else {
          const bamCommands = migration.async.map(cmd =>
            cmd.replace(/\$VERSION\$/g, String(migration.version))
          )
          acc.install = acc.install.concat(bamCommands)
        }
      }

      acc.version = migration.version
      return acc
    }, { install: [] as string[], version })

  assert(result.install.length > 0, `Version ${version} not found.`)

  return { sql: flatten(schema, result.install, result.version!, noAdvisoryLocks), concurrent }
}

// Renders a migration as a single SQL script. The inlined CONCURRENTLY builds are appended
// after COMMIT; this form is meant for printing/export (psql runs them individually). To
// apply programmatically, use migrateCommands() and execute `concurrent` separately.
function migrate (schema: string, version: number, migrations?: types.Migration[], noAdvisoryLocks?: boolean, options: MigrateOptions = {}) {
  const { sql, concurrent } = migrateCommands(schema, version, migrations, noAdvisoryLocks, options)

  return concurrent.length ? `${sql}\n${concurrent.join(';\n')};` : sql
}

const createQueueFn: Record<number, (schema: string) => string> = {
  26: (schema) => `
    CREATE OR REPLACE FUNCTION ${schema}.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
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
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
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

      EXECUTE format('ALTER TABLE ${schema}.%1$I ADD PRIMARY KEY (name, id)', tablename);
      EXECUTE format('ALTER TABLE ${schema}.%1$I ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED', tablename);
      EXECUTE format('ALTER TABLE ${schema}.%1$I ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED', tablename);

      EXECUTE format('CREATE INDEX %1$s_i5 ON ${schema}.%1$I (name, start_after) INCLUDE (priority, created_on, id) WHERE state < ''active''', tablename);
      EXECUTE format('CREATE UNIQUE INDEX %1$s_i4 ON ${schema}.%1$I (name, singleton_on, COALESCE(singleton_key, '''')) WHERE state <> ''cancelled'' AND singleton_on IS NOT NULL', tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE format('CREATE UNIQUE INDEX %1$s_i1 ON ${schema}.%1$I (name, COALESCE(singleton_key, '''')) WHERE state = ''created'' AND policy = ''short''', tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE format('CREATE UNIQUE INDEX %1$s_i2 ON ${schema}.%1$I (name, COALESCE(singleton_key, '''')) WHERE state = ''active'' AND policy = ''singleton''', tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE format('CREATE UNIQUE INDEX %1$s_i3 ON ${schema}.%1$I (name, state, COALESCE(singleton_key, '''')) WHERE state <= ''active'' AND policy = ''stately''', tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE format('CREATE UNIQUE INDEX %1$s_i6 ON ${schema}.%1$I (name, COALESCE(singleton_key, '''')) WHERE state <= ''active'' AND policy = ''exclusive''', tablename);
      END IF;

      EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `,

  27: (schema) => `
    CREATE OR REPLACE FUNCTION ${schema}.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
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
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
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

      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active'$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON ${schema}.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i7 ON ${schema}.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON ${schema}.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `,

  28: (schema) => `
    CREATE OR REPLACE FUNCTION ${schema}.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
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
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
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

      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active'$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON ${schema}.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i7 ON ${schema}.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON ${schema}.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON ${schema}.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `,

  30: (schema) => `
    CREATE OR REPLACE FUNCTION ${schema}.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
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
          heartbeat_seconds
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
          tablename,
          (options->>'heartbeatSeconds')::int
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE ${schema}.%I (LIKE ${schema}.job INCLUDING DEFAULTS)', tablename);

      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active'$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON ${schema}.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i7 ON ${schema}.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON ${schema}.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON ${schema}.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `,

  31: (schema) => `
    CREATE OR REPLACE FUNCTION ${schema}.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
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
          heartbeat_seconds
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
          tablename,
          (options->>'heartbeatSeconds')::int
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE ${schema}.%I (LIKE ${schema}.job INCLUDING DEFAULTS)', tablename);

      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON ${schema}.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i7 ON ${schema}.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON ${schema}.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON ${schema}.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `,

  32: (schema) => `
    CREATE OR REPLACE FUNCTION ${schema}.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
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
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
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

      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON ${schema}.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i7 ON ${schema}.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON ${schema}.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON ${schema}.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `,

  33: (schema) => `
    CREATE OR REPLACE FUNCTION ${schema}.create_queue(queue_name text, options jsonb)
    RETURNS VOID AS
    $$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
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
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
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

      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON ${schema}.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i7 ON ${schema}.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE ${schema}.job_table_format($cmd$CREATE INDEX job_i9 ON ${schema}.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON ${schema}.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON ${schema}.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE ${schema}.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON ${schema}.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE ${schema}.job_table_format($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  `
}

// Frozen per-version snapshots of the queue_stats DDL, version-keyed like createQueueFn above. A
// migration must always emit the DDL as it was authored for that schema version; the plans.* builders
// track the *current* schema and will drift as it evolves, so the migration copies the DDL here
// rather than importing it. When a later version changes queue_stats, add a new keyed entry and leave
// the older ones untouched.
const createTableQueueStatsFn: Record<number, (schema: string, noPartitioning: boolean) => string> = {
  35: (schema, noPartitioning) => noPartitioning
    ? `
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
    : `
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

const createIndexQueueStatsFn: Record<number, (schema: string, noCovering: boolean) => string> = {
  35: (schema, noCovering) => {
    const cols = '(name, captured_on DESC)'
    const include = 'INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count)'
    return noCovering
      ? `CREATE INDEX queue_stats_i1 ON ${schema}.queue_stats ${cols}`
      : `CREATE INDEX queue_stats_i1 ON ${schema}.queue_stats ${cols} ${include}`
  }
}

const ensureQueueStatsPartitionsFn: Record<number, (schema: string) => string> = {
  35: (schema) => `
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

function getAll (schema: string, noPartitioning = false, noCovering = false): types.Migration[] {
  return [
    {
      release: '11.1.0',
      version: 26,
      previous: 25,
      install: [
        createQueueFn[26](schema),
        `CREATE UNIQUE INDEX job_i6 ON ${schema}.job_common (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'`
      ],
      uninstall: [
        `DROP INDEX ${schema}.job_i6`
      ]
    },
    {
      release: '12.6.0',
      version: 27,
      previous: 26,
      install: [
        `ALTER TABLE ${schema}.version ADD COLUMN IF NOT EXISTS bam_on timestamp with time zone`,
        `
        CREATE TABLE IF NOT EXISTS ${schema}.bam (
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
        `,
        `CREATE FUNCTION ${schema}.job_table_format(command text, table_name text)
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
        `,
        `
        CREATE OR REPLACE FUNCTION ${schema}.job_table_run_async(command_name text, version int, command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
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
            'job_common',
            ${schema}.job_table_format(command, 'job_common')
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
        `,
        `
        CREATE OR REPLACE FUNCTION ${schema}.job_table_run(command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
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

          EXECUTE ${schema}.job_table_format(command, 'job_common');

          FOR tbl IN SELECT table_name FROM ${schema}.queue WHERE partition = true
          LOOP
            EXECUTE ${schema}.job_table_format(command, tbl.table_name);
          END LOOP;
        END;
        $$
        LANGUAGE plpgsql;
        `,
        `ALTER TABLE ${schema}.job ADD COLUMN IF NOT EXISTS group_id text`,
        `ALTER TABLE ${schema}.job ADD COLUMN IF NOT EXISTS group_tier text`,
        createQueueFn[27](schema),
        `ALTER INDEX IF EXISTS ${schema}.job_i1 RENAME TO job_common_i1`,
        `ALTER INDEX IF EXISTS ${schema}.job_i2 RENAME TO job_common_i2`,
        `ALTER INDEX IF EXISTS ${schema}.job_i3 RENAME TO job_common_i3`,
        `ALTER INDEX IF EXISTS ${schema}.job_i4 RENAME TO job_common_i4`,
        `ALTER INDEX IF EXISTS ${schema}.job_i5 RENAME TO job_common_i5`,
        `ALTER INDEX IF EXISTS ${schema}.job_i6 RENAME TO job_common_i6`,
        `ALTER INDEX IF EXISTS ${schema}.job_i7 RENAME TO job_common_i7`
      ],
      async: [
        `SELECT ${schema}.job_table_run_async(
          'group_concurency_index',
          $VERSION$,
          $$
          CREATE INDEX CONCURRENTLY job_i7 ON ${schema}.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL
          $$
        )`
      ],
      uninstall: [
        `ALTER INDEX ${schema}.job_common_i6 RENAME TO job_i6`,
        `ALTER INDEX ${schema}.job_common_i5 RENAME TO job_i5`,
        `ALTER INDEX ${schema}.job_common_i4 RENAME TO job_i4`,
        `ALTER INDEX ${schema}.job_common_i3 RENAME TO job_i3`,
        `ALTER INDEX ${schema}.job_common_i2 RENAME TO job_i2`,
        `ALTER INDEX ${schema}.job_common_i1 RENAME TO job_i1`,
        `SELECT ${schema}.job_table_run('DROP INDEX ${schema}.job_i7')`,
        createQueueFn[26](schema),
        `DROP FUNCTION ${schema}.job_table_run(text, text, text)`,
        `DROP FUNCTION ${schema}.job_table_run_async(text, int, text, text, text)`,
        `DROP FUNCTION ${schema}.job_table_format(text, text)`,
        `DROP TABLE ${schema}.bam`,
        `ALTER TABLE ${schema}.version DROP COLUMN bam_on`,
        `ALTER TABLE ${schema}.job DROP COLUMN group_tier`,
        `ALTER TABLE ${schema}.job DROP COLUMN group_id`
      ]
    },
    {
      release: '12.10.0',
      version: 28,
      previous: 27,
      install: [
        // Create key_strict_fifo CHECK constraint on job_common (the default partition)
        `SELECT ${schema}.job_table_run($cmd$ALTER TABLE ${schema}.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, 'job_common')`,
        createQueueFn[28](schema)
      ],
      async: [
        `SELECT ${schema}.job_table_run_async(
          'key_strict_fifo_index',
          $VERSION$,
          $$
          CREATE UNIQUE INDEX CONCURRENTLY job_i8 ON ${schema}.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'
          $$
        , 'job_common')`
      ],
      uninstall: [
        `SELECT ${schema}.job_table_run('DROP INDEX IF EXISTS ${schema}.job_i8')`,
        `SELECT ${schema}.job_table_run('ALTER TABLE ${schema}.job DROP CONSTRAINT IF EXISTS job_key_strict_fifo_singleton_key_check')`,
        createQueueFn[27](schema)
      ]
    },
    {
      release: '12.11.0',
      version: 29,
      previous: 28,
      install: [
        `CREATE TABLE ${schema}.warning (
          id uuid PRIMARY KEY default gen_random_uuid(),
          type text NOT NULL,
          message text NOT NULL,
          data jsonb,
          created_on timestamp with time zone NOT NULL DEFAULT now()
        )`,
        `CREATE INDEX warning_i1 ON ${schema}.warning (created_on DESC)`
      ],
      uninstall: [
        `DROP INDEX ${schema}.warning_i1`,
        `DROP TABLE ${schema}.warning`
      ]
    },
    {
      release: '12.12.0',
      version: 30,
      previous: 29,
      install: [
        `ALTER TABLE ${schema}.job ADD COLUMN heartbeat_on timestamp with time zone`,
        `ALTER TABLE ${schema}.job ADD COLUMN heartbeat_seconds int`,
        `ALTER TABLE ${schema}.queue ADD COLUMN heartbeat_seconds int`,
        createQueueFn[30](schema)
      ],
      uninstall: [
        createQueueFn[28](schema),
        `ALTER TABLE ${schema}.queue DROP COLUMN heartbeat_seconds`,
        `ALTER TABLE ${schema}.job DROP COLUMN heartbeat_seconds`,
        `ALTER TABLE ${schema}.job DROP COLUMN heartbeat_on`
      ]
    },
    {
      release: '12.19.0',
      version: 31,
      previous: 30,
      install: [
        `ALTER TABLE ${schema}.job ADD COLUMN blocked boolean NOT NULL DEFAULT false`,
        `ALTER TABLE ${schema}.job ADD COLUMN blocking boolean NOT NULL DEFAULT false`,
        `ALTER TABLE ${schema}.job ADD COLUMN pending_dependencies int NOT NULL DEFAULT 0`,
        `
        CREATE TABLE IF NOT EXISTS ${schema}.job_dependency (
          child_name text NOT NULL,
          child_id uuid NOT NULL,
          parent_name text NOT NULL,
          parent_id uuid NOT NULL,
          PRIMARY KEY (child_name, child_id, parent_name, parent_id)
        )
        `,
        `CREATE INDEX IF NOT EXISTS job_dep_parent_idx ON ${schema}.job_dependency (parent_name, parent_id)`,
        // NOTE: the v31 job_i5 rebuild (adding `AND NOT blocked`) is intentionally omitted — v33
        // drops and rebuilds job_i5 again (slimming off the covering INCLUDE), so on a multi-version
        // upgrade (<= v31 -> >= v33, applied as one migration transaction) this only built a covering
        // index that v33 immediately throws away. The whole migration runs in a single transaction,
        // so no worker observes the pre-v33 shape; the old job_i5 simply persists untouched until v33
        // replaces it. Anyone who already migrated to exactly v31/v32 keeps the index they built then,
        // so removing the build here does not affect them. New partitions created while on v31 still
        // get the correct shape from createQueueFn[31] below.
        // `SELECT ${schema}.job_table_run($cmd$DROP INDEX IF EXISTS ${schema}.job_i5$cmd$)`,
        // `SELECT ${schema}.job_table_run($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active' AND NOT blocked$cmd$)`,
        createQueueFn[31](schema)
      ],
      uninstall: [
        `DROP INDEX IF EXISTS ${schema}.job_dep_parent_idx`,
        `DROP TABLE IF EXISTS ${schema}.job_dependency`,
        createQueueFn[30](schema),
        `SELECT ${schema}.job_table_run($cmd$DROP INDEX IF EXISTS ${schema}.job_i5$cmd$)`,
        `SELECT ${schema}.job_table_run($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active'$cmd$)`,
        `ALTER TABLE ${schema}.job DROP COLUMN pending_dependencies`,
        `ALTER TABLE ${schema}.job DROP COLUMN blocking`,
        `ALTER TABLE ${schema}.job DROP COLUMN blocked`
      ]
    },
    {
      release: '12.21.0',
      version: 32,
      previous: 31,
      install: [
        `ALTER TABLE ${schema}.queue ADD COLUMN notify boolean NOT NULL DEFAULT false`,
        createQueueFn[32](schema),
        `ALTER TABLE ${schema}.queue ADD COLUMN failed_count int NOT NULL DEFAULT 0`,
        `ALTER TABLE ${schema}.queue ADD COLUMN ready_count int NOT NULL DEFAULT 0`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.queue DROP COLUMN ready_count`,
        `ALTER TABLE ${schema}.queue DROP COLUMN failed_count`,
        createQueueFn[31](schema),
        `ALTER TABLE ${schema}.queue DROP COLUMN notify`
      ]
    },
    {
      release: '12.22.0',
      version: 33,
      previous: 32,
      install: [
        `ALTER TABLE ${schema}.version ADD COLUMN IF NOT EXISTS flow_on timestamp with time zone`,
        // The job_i9 build and job_i5 reshape are run OFF the migration transaction, via BAM as
        // CONCURRENTLY DDL — see the `async` block below. The original v33 ran them synchronously here
        // via job_table_run(), taking SHARE/ACCESS EXCLUSIVE locks on job_common + every partition
        // inside the migration transaction, which deadlocked live workers polling job_common during a
        // rolling deploy (issue #832).
        //
        // Only databases that have NOT yet passed v33 execute this install, and they always have the
        // covering job_i5 (the slim form is introduced here) — so the reshape never needlessly
        // rebuilds an already-slim index. Databases already past v33 keep what they built then; they
        // pick up only the bam default change, carried separately by migration v36.
        //
        // Set the bam queue's created_on default to clock_timestamp() BEFORE the enqueues below. BAM
        // applies queued commands in created_on order, and the job_i5 reshape is an ordered
        // drop-then-rebuild; now() is constant within this migration transaction and would tie them.
        // (Migrations run in version order, so this must be in v33 — v36 runs after these enqueues.)
        `ALTER TABLE ${schema}.bam ALTER COLUMN created_on SET DEFAULT clock_timestamp()`,
        createQueueFn[33](schema)
      ],
      async: [
        // Partial index backing the background flow resolver.
        `SELECT ${schema}.job_table_run_async(
          'flow_resolver_index',
          $VERSION$,
          $$
          CREATE INDEX CONCURRENTLY IF NOT EXISTS job_i9 ON ${schema}.job (name, id) WHERE blocking AND state = 'completed'
          $$
        )`,
        // Slim the fetch index job_i5: drop the covering INCLUDE (priority, created_on, id) — the
        // fetch's FOR UPDATE ... SKIP LOCKED forces heap access, so the payload was never read from
        // the index. Drop-then-rebuild (CONCURRENTLY can't reshape in place); BAM runs them in
        // created_on order, drop before rebuild (see the clock_timestamp() default set above).
        `SELECT ${schema}.job_table_run_async(
          'fetch_index_drop',
          $VERSION$,
          $$
          DROP INDEX CONCURRENTLY IF EXISTS ${schema}.job_i5
          $$
        )`,
        `SELECT ${schema}.job_table_run_async(
          'fetch_index',
          $VERSION$,
          $$
          CREATE INDEX CONCURRENTLY IF NOT EXISTS job_i5 ON ${schema}.job (name, start_after) WHERE state < 'active' AND NOT blocked
          $$
        )`
      ],
      uninstall: [
        createQueueFn[32](schema),
        // Restore the covering INCLUDE on the fetch index (the v32 shape).
        `SELECT ${schema}.job_table_run($cmd$DROP INDEX IF EXISTS ${schema}.job_i5$cmd$)`,
        `SELECT ${schema}.job_table_run($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active' AND NOT blocked$cmd$)`,
        `SELECT ${schema}.job_table_run($cmd$DROP INDEX IF EXISTS ${schema}.job_i9$cmd$)`,
        `ALTER TABLE ${schema}.version DROP COLUMN flow_on`
      ]
    },
    {
      release: '12.23.0',
      version: 34,
      previous: 33,
      // Dead-letter source provenance. Plain columns on the partitioned parent cascade to
      // job_common (DEFAULT partition) and every existing/future partition, so no job_table_run
      // fan-out or createQueueFn bump is needed (queue-creation/index logic is unchanged).
      install: [
        `ALTER TABLE ${schema}.job ADD COLUMN IF NOT EXISTS source_name text`,
        `ALTER TABLE ${schema}.job ADD COLUMN IF NOT EXISTS source_id uuid`,
        `ALTER TABLE ${schema}.job ADD COLUMN IF NOT EXISTS source_created_on timestamp with time zone`,
        `ALTER TABLE ${schema}.job ADD COLUMN IF NOT EXISTS source_retry_count int`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job DROP COLUMN source_name`,
        `ALTER TABLE ${schema}.job DROP COLUMN source_id`,
        `ALTER TABLE ${schema}.job DROP COLUMN source_created_on`,
        `ALTER TABLE ${schema}.job DROP COLUMN source_retry_count`
      ]
    },
    {
      release: '12.24.0',
      version: 35,
      previous: 34,
      // Mirror plans.create(): honor noTablePartitioning so upgrades on non-partitioning
      // deployments (e.g. CockroachDB, which rejects declarative RANGE partitioning) get a plain
      // queue_stats table instead of a partitioned one they could never maintain. noCovering is a
      // separate axis (CockroachDB sets it, YugabyteDB doesn't) gating the index's covering INCLUDE.
      // Also adds queue.ready_history: an always-on sliding window of recent ready counts on the
      // queue row for the dashboard sparkline (maintained by cacheQueueStats every monitor cycle,
      // independent of persistQueueStats). NOT NULL DEFAULT '{}' backfills existing rows with an
      // empty window that fills in over the next monitor cycles.
      install: [
        ...(noPartitioning
          ? [
              createTableQueueStatsFn[35](schema, true),
              createIndexQueueStatsFn[35](schema, noCovering)
            ]
          : [
              createTableQueueStatsFn[35](schema, false),
              createIndexQueueStatsFn[35](schema, noCovering),
              ensureQueueStatsPartitionsFn[35](schema)
            ]),
        `ALTER TABLE ${schema}.queue ADD COLUMN ready_history int[] NOT NULL DEFAULT '{}'`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.queue DROP COLUMN ready_history`,
        `DROP TABLE IF EXISTS ${schema}.queue_stats`
      ]
    },
    {
      release: '12.24.1',
      version: 36,
      previous: 35,
      // Carry only the bam.created_on default change (now() -> clock_timestamp()) to databases that
      // already ran v33 and so won't re-run its install. This keeps a fully-migrated database's schema
      // identical to a fresh install (plans.create builds the bam table with this default), and lets a
      // future async migration enqueue an ordered drop-then-rebuild without the now() tie. The ALTER
      // is idempotent, so databases that just ran v33's copy of it (a multi-version upgrade) are
      // unaffected. No index work here — that lives in v33, which the deadlock-affected (pre-v33)
      // databases run; databases already past v33 keep the indexes they built and skip the churn.
      install: [
        `ALTER TABLE ${schema}.bam ALTER COLUMN created_on SET DEFAULT clock_timestamp()`
      ],
      // The default change is forward-compatible and harmless to keep, so rollback leaves it in place.
      uninstall: []
    }
  ]
}

export {
  rollback,
  next,
  migrate,
  migrateCommands,
  getAll,
}
