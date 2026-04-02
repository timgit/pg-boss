import assert from 'node:assert'
import * as plans from './plans.ts'
import * as types from './types.ts'

function flatten (schema: string, commands: string[], version: number) {
  commands.unshift(plans.assertMigration(schema, version))
  commands.push(plans.setVersion(schema, version))

  return plans.locked(schema, commands)
}

function rollback (schema: string, version: number, migrations?: types.Migration[]) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.version === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.uninstall || [], result.previous)
}

function next (schema: string, version: number, migrations: types.Migration[] | undefined) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.previous === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

function migrate (schema: string, version: number, migrations?: types.Migration[]) {
  migrations = migrations || getAll(schema)

  const result = migrations
    .filter(i => i.previous >= version!)
    .sort((a, b) => a.version - b.version)
    .reduce((acc, migration) => {
      acc.install = acc.install.concat(migration.install)

      if (migration.async) {
        const bamCommands = migration.async.map(cmd =>
          cmd.replace(/\$VERSION\$/g, String(migration.version))
        )
        acc.install = acc.install.concat(bamCommands)
      }

      acc.version = migration.version
      return acc
    }, { install: [] as string[], version })

  assert(result.install.length > 0, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version!)
}

function getAll (schema: string): types.Migration[] {
  return [
    {
      release: '11.1.0',
      version: 26,
      previous: 25,
      install: [
        `
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
        `
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
        `
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
        // Update create_queue function to include the FIFO index for partitioned tables
        `
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
        `
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
        // Restore previous version of create_queue function (without key_strict_fifo support)
        `
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
        `
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
        `
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
        `
      ],
      uninstall: [
        // Restore previous version of create_queue function (without heartbeat_seconds)
        `
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
        `ALTER TABLE ${schema}.queue DROP COLUMN heartbeat_seconds`,
        `ALTER TABLE ${schema}.job DROP COLUMN heartbeat_seconds`,
        `ALTER TABLE ${schema}.job DROP COLUMN heartbeat_on`
      ]
    },
    {
      release: '12.15.0',
      version: 31,
      previous: 30,
      install: [
        `ALTER TABLE ${schema}.job ADD COLUMN blocked boolean NOT NULL DEFAULT false`,
        `ALTER TABLE ${schema}.job ADD COLUMN blocking boolean NOT NULL DEFAULT false`,
        `
        CREATE TABLE IF NOT EXISTS ${schema}.job_dependency (
          child_name text NOT NULL,
          child_id uuid NOT NULL,
          parent_name text NOT NULL,
          parent_id uuid NOT NULL,
          PRIMARY KEY (child_name, child_id, parent_name, parent_id)
        )
        `,
        `CREATE INDEX job_dep_parent_idx ON ${schema}.job_dependency (parent_name, parent_id)`,
        `SELECT ${schema}.job_table_run($cmd$DROP INDEX IF EXISTS ${schema}.job_i5$cmd$)`,
        `SELECT ${schema}.job_table_run($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active' AND NOT blocked$cmd$)`,
        `
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
        `
        CREATE OR REPLACE FUNCTION ${schema}.complete_jobs(
          queue_name text,
          job_table text,
          job_ids uuid[],
          job_output jsonb,
          include_queued boolean DEFAULT false
        )
        RETURNS bigint AS
        $$
        DECLARE
          completed_count bigint;
          has_blocking boolean;
        BEGIN
          EXECUTE format(
            'CREATE TEMP TABLE _completed ON COMMIT DROP AS
             WITH results AS (
               UPDATE %I.%I
               SET completed_on = now(),
                   state = ''completed'',
                   output = $1
               WHERE name = $2
                 AND id IN (SELECT UNNEST($3))
                 AND %s
               RETURNING *
             )
             SELECT * FROM results',
            '${schema}', job_table,
            CASE WHEN include_queued
              THEN 'state < ''completed'''
              ELSE 'state = ''active'''
            END
          ) USING job_output, queue_name, job_ids;

          SELECT COUNT(*) INTO completed_count FROM _completed;

          IF completed_count = 0 THEN
            RETURN 0;
          END IF;

          SELECT EXISTS(SELECT 1 FROM _completed WHERE blocking = true)
            INTO has_blocking;

          IF has_blocking THEN
            EXECUTE format(
              'UPDATE %I.job j
               SET blocked = false
               FROM (
                 SELECT DISTINCT d.child_name, d.child_id
                 FROM %I.job_dependency d
                 JOIN _completed c ON c.name = d.parent_name AND c.id = d.parent_id
                 WHERE c.blocking = true
               ) ct
               WHERE j.name = ct.child_name
                 AND j.id = ct.child_id
                 AND j.blocked = true
                 AND NOT EXISTS (
                   SELECT 1
                   FROM %I.job_dependency d2
                   JOIN %I.job p ON p.name = d2.parent_name AND p.id = d2.parent_id
                   LEFT JOIN _completed r ON r.name = p.name AND r.id = p.id
                   WHERE d2.child_name = ct.child_name
                     AND d2.child_id = ct.child_id
                     AND p.state <> ''completed''
                     AND r.id IS NULL
                 )',
              '${schema}', '${schema}', '${schema}', '${schema}'
            );
          END IF;

          RETURN completed_count;
        END;
        $$
        LANGUAGE plpgsql;
        `
      ],
      uninstall: [
        `DROP FUNCTION IF EXISTS ${schema}.complete_jobs`,
        `DROP INDEX IF EXISTS ${schema}.job_dep_parent_idx`,
        `DROP TABLE IF EXISTS ${schema}.job_dependency`,
        `
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
        `SELECT ${schema}.job_table_run($cmd$DROP INDEX IF EXISTS ${schema}.job_i5$cmd$)`,
        `SELECT ${schema}.job_table_run($cmd$CREATE INDEX job_i5 ON ${schema}.job (name, start_after) INCLUDE (priority, created_on, id) WHERE state < 'active'$cmd$)`,
        `ALTER TABLE ${schema}.job DROP COLUMN blocking`,
        `ALTER TABLE ${schema}.job DROP COLUMN blocked`
      ]
    }
  ]
}

export {
  rollback,
  next,
  migrate,
  getAll,
}
