import assert from 'node:assert'
import * as plans from './plans.ts'
import * as types from './types.ts'

function flatten (schema: string, commands: string[], version: number | null) {
  commands.unshift(plans.assertMigration(schema, version))
  commands.push(plans.setVersion(schema, version))

  return plans.locked(schema, commands)
}

function rollback (schema: string, version: number | null = null, migrations?: types.Migration[]) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.version === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.uninstall || [], result.previous)
}

function next (schema: string, version: number | null, migrations: types.Migration[] | undefined) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.previous === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

function migrate (schema: string, version: number | null = null, migrations?: types.Migration[]) {
  migrations = migrations || getAll(schema)

  const result = migrations
    .filter(i => i.previous >= version!)
    .sort((a, b) => a.version - b.version)
    .reduce((acc, i) => {
      acc.install = acc.install.concat(i.install)
      acc.version = i.version
      return acc
    }, { install: [] as string[], version })

  assert(result.install.length > 0, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
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
    },]
}

export {
  rollback,
  next,
  migrate,
  getAll,
}
