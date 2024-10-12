const assert = require('node:assert')
const plans = require('./plans')

module.exports = {
  rollback,
  next,
  migrate,
  getAll
}

function flatten (schema, commands, version) {
  commands.unshift(plans.assertMigration(schema, version))
  commands.push(plans.setVersion(schema, version))

  return plans.locked(schema, commands)
}

function rollback (schema, version, migrations) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.version === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.uninstall || [], result.previous)
}

function next (schema, version, migrations) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.previous === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

function migrate (value, version, migrations) {
  let schema, config

  if (typeof value === 'string') {
    config = null
    schema = value
  } else {
    config = value
    schema = config.schema
  }

  migrations = migrations || getAll(schema, config)

  const result = migrations
    .filter(i => i.previous >= version)
    .sort((a, b) => a.version - b.version)
    .reduce((acc, i) => {
      acc.install = acc.install.concat(i.install)
      acc.version = i.version
      return acc
    }, { install: [], version })

  assert(result.install.length > 0, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

function getAll (schema) {
  return [
    {
      release: '10.1.5',
      version: 24,
      previous: 23,
      install: [
        `
        CREATE OR REPLACE FUNCTION ${schema}.create_queue(queue_name text, options json)
        RETURNS VOID AS
        $$
        DECLARE
          table_name varchar := 'j' || encode(sha224(queue_name::bytea), 'hex');
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
              dead_letter,
              partition_name
            )
            VALUES (
              queue_name,
              options->>'policy',
              (options->>'retryLimit')::int,
              (options->>'retryDelay')::int,
              (options->>'retryBackoff')::bool,
              (options->>'expireInSeconds')::int,
              (options->>'retentionMinutes')::int,
              options->>'deadLetter',
              table_name
            )
            ON CONFLICT DO NOTHING
            RETURNING created_on
          )
          SELECT created_on into queue_created_on from q;

          IF queue_created_on IS NULL THEN
            RETURN;
          END IF;

          EXECUTE format('CREATE TABLE ${schema}.%I (LIKE ${schema}.job INCLUDING DEFAULTS)', table_name);
          
          EXECUTE format('ALTER TABLE ${schema}.%1$I ADD PRIMARY KEY (name, id)', table_name);
          EXECUTE format('ALTER TABLE ${schema}.%1$I ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED', table_name);
          EXECUTE format('ALTER TABLE ${schema}.%1$I ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES ${schema}.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED', table_name);
          EXECUTE format('CREATE UNIQUE INDEX %1$s_i1 ON ${schema}.%1$I (name, COALESCE(singleton_key, '''')) WHERE state = ''created'' AND policy = ''short''', table_name);
          EXECUTE format('CREATE UNIQUE INDEX %1$s_i2 ON ${schema}.%1$I (name, COALESCE(singleton_key, '''')) WHERE state = ''active'' AND policy = ''singleton''', table_name);
          EXECUTE format('CREATE UNIQUE INDEX %1$s_i3 ON ${schema}.%1$I (name, state, COALESCE(singleton_key, '''')) WHERE state <= ''active'' AND policy = ''stately''', table_name);
          EXECUTE format('CREATE UNIQUE INDEX %1$s_i4 ON ${schema}.%1$I (name, singleton_on, COALESCE(singleton_key, '''')) WHERE state <> ''cancelled'' AND singleton_on IS NOT NULL', table_name);
          EXECUTE format('CREATE INDEX %1$s_i5 ON ${schema}.%1$I (name, start_after) INCLUDE (priority, created_on, id) WHERE state < ''active''', table_name);

          EXECUTE format('ALTER TABLE ${schema}.%I ADD CONSTRAINT cjc CHECK (name=%L)', table_name, queue_name);
          EXECUTE format('ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.%I FOR VALUES IN (%L)', table_name, queue_name);
        END;
        $$
        LANGUAGE plpgsql
        `
      ],
      uninstall: []
    },
    {
      release: '10.1.1',
      version: 23,
      previous: 22,
      install: [
        `ALTER TABLE ${schema}.job ADD PRIMARY KEY (name, id)`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job DROP CONSTRAINT job_pkey`
      ]
    },
    {
      release: '10.0.6',
      version: 22,
      previous: 21,
      install: [
        `ALTER TABLE ${schema}.job ALTER COLUMN retry_limit SET DEFAULT 2`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job ALTER COLUMN retry_limit SET DEFAULT 0`
      ]
    }
  ]
}
