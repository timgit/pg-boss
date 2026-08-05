=== create default ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgboss')::bytea), 'hex'))::bit(64)::bigint
  );
;

    CREATE TYPE pgboss.job_state AS ENUM (
      'created',
      'retry',
      'active',
      'completed',
      'cancelled',
      'failed'
    )
  ;

    CREATE TABLE pgboss.version (
      version int primary key,
      cron_on timestamp with time zone,
      bam_on timestamp with time zone,
      flow_on timestamp with time zone
    )
  ;

    CREATE TABLE pgboss.queue (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit int NOT NULL,
      retry_delay int NOT NULL,
      retry_backoff bool NOT NULL,
      retry_delay_max int,
      expire_seconds int NOT NULL,
      retention_seconds int NOT NULL,
      deletion_seconds int NOT NULL,
      dead_letter text REFERENCES pgboss.queue (name) CHECK (dead_letter IS DISTINCT FROM name),
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
  ;

    CREATE TABLE pgboss.schedule (
      name text REFERENCES pgboss.queue ON DELETE CASCADE,
      key text not null DEFAULT '',
      cron text not null,
      timezone text,
      data jsonb,
      options jsonb,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name, key)
    )
  ;

    CREATE TABLE pgboss.subscription (
      event text not null,
      name text not null REFERENCES pgboss.queue ON DELETE CASCADE,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY(event, name)
    )
  ;

    CREATE TABLE pgboss.bam (
      id uuid PRIMARY KEY default gen_random_uuid(),
      name text NOT NULL,
      version int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      queue text,
      table_name text NOT NULL,
      command text NOT NULL,
      error text,
      -- clock_timestamp() (not now()) so multiple job_table_run_async() enqueues within a single
      -- migration transaction keep their insertion order — BAM applies queued commands in created_on
      -- order, and some migrations enqueue an ordered drop-then-rebuild pair (see migration v33).
      created_on timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone
    )
  ;

    CREATE FUNCTION pgboss.job_table_format(command text, table_name text)
    RETURNS text AS
    $$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $$
    LANGUAGE sql IMMUTABLE;
  ;

    CREATE FUNCTION pgboss.job_table_run(command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE pgboss.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE pgboss.job_table_format(command, 'job_common');

      FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true
      LOOP
        EXECUTE pgboss.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION pgboss.job_table_run_async(command_name text, version int, command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          pgboss.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        'job_common',
        pgboss.job_table_format(command, 'job_common')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        pgboss.job_table_format(command, queue.table_name)
      FROM pgboss.queue
      WHERE partition = true;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE TABLE pgboss.job (
      id uuid not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state pgboss.job_state not null default 'created',
      retry_limit integer not null default 2,
      retry_count integer not null default 0,
      retry_delay integer not null default 0,
      retry_backoff boolean not null default false,
      retry_delay_max integer,
      expire_seconds int not null default 900,
      deletion_seconds int not null default 604800,
      singleton_key text,
      singleton_on timestamp without time zone,
      group_id text,
      group_tier text,
      start_after timestamp with time zone not null default now(),
      created_on timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '1209600',
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
    ) PARTITION BY LIST (name)
  ;
ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id);

    CREATE TABLE pgboss.job_common (LIKE pgboss.job INCLUDING GENERATED INCLUDING DEFAULTS);

    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE state < 'active' AND NOT blocked$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, 'job_common');

    ALTER TABLE pgboss.job ATTACH PARTITION pgboss.job_common DEFAULT;
  ;

    CREATE TABLE pgboss.warning (
      id uuid PRIMARY KEY default gen_random_uuid(),
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamp with time zone NOT NULL DEFAULT now()
    )
  ;
CREATE INDEX warning_i1 ON pgboss.warning (created_on DESC);

    CREATE TABLE pgboss.queue_stats (
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
  ;
CREATE INDEX queue_stats_i1 ON pgboss.queue_stats (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);

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
          WHERE n.nspname = 'pgboss' AND c.relname = part_name
        ) THEN
          EXECUTE format(
            'CREATE TABLE pgboss.%I PARTITION OF pgboss.queue_stats FOR VALUES FROM (%L) TO (%L)',
            part_name,
            to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
          );
        END IF;
      END LOOP;
    END;
    $$
  ;

    CREATE TABLE pgboss.job_dependency (
      child_name text NOT NULL,
      child_id uuid NOT NULL,
      parent_name text NOT NULL,
      parent_id uuid NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )
  ;
CREATE INDEX IF NOT EXISTS job_dep_parent_idx ON pgboss.job_dependency (parent_name, parent_id);

    CREATE FUNCTION pgboss.create_queue(queue_name text, options jsonb)
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
        INSERT INTO pgboss.queue (
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

      EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename);

      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION pgboss.delete_queue(queue_name text)
    RETURNS VOID AS
    $$
    DECLARE
      v_table varchar;
      v_partition bool;
    BEGIN
      
      SELECT table_name, partition
      FROM pgboss.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name);
      END IF;
    
      DELETE FROM pgboss.queue WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  ;
INSERT INTO pgboss.version(version) VALUES ('37');
    COMMIT;
  

=== create with schema ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgboss')::bytea), 'hex'))::bit(64)::bigint
  );
CREATE SCHEMA IF NOT EXISTS pgboss;

    CREATE TYPE pgboss.job_state AS ENUM (
      'created',
      'retry',
      'active',
      'completed',
      'cancelled',
      'failed'
    )
  ;

    CREATE TABLE pgboss.version (
      version int primary key,
      cron_on timestamp with time zone,
      bam_on timestamp with time zone,
      flow_on timestamp with time zone
    )
  ;

    CREATE TABLE pgboss.queue (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit int NOT NULL,
      retry_delay int NOT NULL,
      retry_backoff bool NOT NULL,
      retry_delay_max int,
      expire_seconds int NOT NULL,
      retention_seconds int NOT NULL,
      deletion_seconds int NOT NULL,
      dead_letter text REFERENCES pgboss.queue (name) CHECK (dead_letter IS DISTINCT FROM name),
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
  ;

    CREATE TABLE pgboss.schedule (
      name text REFERENCES pgboss.queue ON DELETE CASCADE,
      key text not null DEFAULT '',
      cron text not null,
      timezone text,
      data jsonb,
      options jsonb,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name, key)
    )
  ;

    CREATE TABLE pgboss.subscription (
      event text not null,
      name text not null REFERENCES pgboss.queue ON DELETE CASCADE,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY(event, name)
    )
  ;

    CREATE TABLE pgboss.bam (
      id uuid PRIMARY KEY default gen_random_uuid(),
      name text NOT NULL,
      version int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      queue text,
      table_name text NOT NULL,
      command text NOT NULL,
      error text,
      -- clock_timestamp() (not now()) so multiple job_table_run_async() enqueues within a single
      -- migration transaction keep their insertion order — BAM applies queued commands in created_on
      -- order, and some migrations enqueue an ordered drop-then-rebuild pair (see migration v33).
      created_on timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone
    )
  ;

    CREATE FUNCTION pgboss.job_table_format(command text, table_name text)
    RETURNS text AS
    $$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $$
    LANGUAGE sql IMMUTABLE;
  ;

    CREATE FUNCTION pgboss.job_table_run(command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE pgboss.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE pgboss.job_table_format(command, 'job_common');

      FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true
      LOOP
        EXECUTE pgboss.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION pgboss.job_table_run_async(command_name text, version int, command text, tbl_name text DEFAULT NULL, queue_name text DEFAULT NULL)
    RETURNS VOID AS
    $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          pgboss.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        'job_common',
        pgboss.job_table_format(command, 'job_common')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        pgboss.job_table_format(command, queue.table_name)
      FROM pgboss.queue
      WHERE partition = true;
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE TABLE pgboss.job (
      id uuid not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state pgboss.job_state not null default 'created',
      retry_limit integer not null default 2,
      retry_count integer not null default 0,
      retry_delay integer not null default 0,
      retry_backoff boolean not null default false,
      retry_delay_max integer,
      expire_seconds int not null default 900,
      deletion_seconds int not null default 604800,
      singleton_key text,
      singleton_on timestamp without time zone,
      group_id text,
      group_tier text,
      start_after timestamp with time zone not null default now(),
      created_on timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '1209600',
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
    ) PARTITION BY LIST (name)
  ;
ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id);

    CREATE TABLE pgboss.job_common (LIKE pgboss.job INCLUDING GENERATED INCLUDING DEFAULTS);

    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE state < 'active' AND NOT blocked$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, 'job_common');
    SELECT pgboss.job_table_run($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, 'job_common');

    ALTER TABLE pgboss.job ATTACH PARTITION pgboss.job_common DEFAULT;
  ;

    CREATE TABLE pgboss.warning (
      id uuid PRIMARY KEY default gen_random_uuid(),
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamp with time zone NOT NULL DEFAULT now()
    )
  ;
CREATE INDEX warning_i1 ON pgboss.warning (created_on DESC);

    CREATE TABLE pgboss.queue_stats (
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
  ;
CREATE INDEX queue_stats_i1 ON pgboss.queue_stats (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);

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
          WHERE n.nspname = 'pgboss' AND c.relname = part_name
        ) THEN
          EXECUTE format(
            'CREATE TABLE pgboss.%I PARTITION OF pgboss.queue_stats FOR VALUES FROM (%L) TO (%L)',
            part_name,
            to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
          );
        END IF;
      END LOOP;
    END;
    $$
  ;

    CREATE TABLE pgboss.job_dependency (
      child_name text NOT NULL,
      child_id uuid NOT NULL,
      parent_name text NOT NULL,
      parent_id uuid NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )
  ;
CREATE INDEX IF NOT EXISTS job_dep_parent_idx ON pgboss.job_dependency (parent_name, parent_id);

    CREATE FUNCTION pgboss.create_queue(queue_name text, options jsonb)
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
        INSERT INTO pgboss.queue (
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

      EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename);

      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $$
    LANGUAGE plpgsql;
  ;

    CREATE FUNCTION pgboss.delete_queue(queue_name text)
    RETURNS VOID AS
    $$
    DECLARE
      v_table varchar;
      v_partition bool;
    BEGIN
      
      SELECT table_name, partition
      FROM pgboss.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name);
      END IF;
    
      DELETE FROM pgboss.queue WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  ;
INSERT INTO pgboss.version(version) VALUES ('37');
    COMMIT;
  

=== create all flags ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    CREATE SCHEMA IF NOT EXISTS pgboss;

    CREATE TYPE pgboss.job_state AS ENUM (
      'created',
      'retry',
      'active',
      'completed',
      'cancelled',
      'failed'
    )
  ;

    CREATE TABLE pgboss.version (
      version int primary key,
      cron_on timestamp with time zone,
      bam_on timestamp with time zone,
      flow_on timestamp with time zone
    )
  ;

    CREATE TABLE pgboss.queue (
      name text NOT NULL,
      policy text NOT NULL,
      retry_limit int NOT NULL,
      retry_delay int NOT NULL,
      retry_backoff bool NOT NULL,
      retry_delay_max int,
      expire_seconds int NOT NULL,
      retention_seconds int NOT NULL,
      deletion_seconds int NOT NULL,
      dead_letter text REFERENCES pgboss.queue (name) CHECK (dead_letter IS DISTINCT FROM name),
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
  ;

    CREATE TABLE pgboss.schedule (
      name text REFERENCES pgboss.queue ON DELETE CASCADE,
      key text not null DEFAULT '',
      cron text not null,
      timezone text,
      data jsonb,
      options jsonb,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY (name, key)
    )
  ;

    CREATE TABLE pgboss.subscription (
      event text not null,
      name text not null REFERENCES pgboss.queue ON DELETE CASCADE,
      created_on timestamp with time zone not null default now(),
      updated_on timestamp with time zone not null default now(),
      PRIMARY KEY(event, name)
    )
  ;

    CREATE TABLE pgboss.bam (
      id uuid PRIMARY KEY default gen_random_uuid(),
      name text NOT NULL,
      version int NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      queue text,
      table_name text NOT NULL,
      command text NOT NULL,
      error text,
      -- clock_timestamp() (not now()) so multiple job_table_run_async() enqueues within a single
      -- migration transaction keep their insertion order — BAM applies queued commands in created_on
      -- order, and some migrations enqueue an ordered drop-then-rebuild pair (see migration v33).
      created_on timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone
    )
  ;
;
;
;

    CREATE TABLE pgboss.job (
      id uuid not null default gen_random_uuid(),
      name text not null,
      priority integer not null default(0),
      data jsonb,
      state pgboss.job_state not null default 'created',
      retry_limit integer not null default 2,
      retry_count integer not null default 0,
      retry_delay integer not null default 0,
      retry_backoff boolean not null default false,
      retry_delay_max integer,
      expire_seconds int not null default 900,
      deletion_seconds int not null default 604800,
      singleton_key text,
      singleton_on timestamp without time zone,
      group_id text,
      group_tier text,
      start_after timestamp with time zone not null default now(),
      created_on timestamp with time zone not null default now(),
      started_on timestamp with time zone,
      completed_on timestamp with time zone,
      keep_until timestamp with time zone NOT NULL default now() + interval '1209600',
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
    ) 
  ;
ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id);

    ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT;
    ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short';
    CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton';
    CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately';
    CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive';
    CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo';
    ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL));
    CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL;
    CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE state < 'active' AND NOT blocked;
    CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL;
    CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed';
  ;

    CREATE TABLE pgboss.warning (
      id uuid PRIMARY KEY default gen_random_uuid(),
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamp with time zone NOT NULL DEFAULT now()
    )
  ;
CREATE INDEX warning_i1 ON pgboss.warning (created_on DESC);

    CREATE TABLE pgboss.queue_stats (
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
  ;
CREATE INDEX queue_stats_i1 ON pgboss.queue_stats (name, captured_on DESC) ;
;

    CREATE TABLE pgboss.job_dependency (
      child_name text NOT NULL,
      child_id uuid NOT NULL,
      parent_name text NOT NULL,
      parent_id uuid NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )
  ;
CREATE INDEX IF NOT EXISTS job_dep_parent_idx ON pgboss.job_dependency (parent_name, parent_id);

      CREATE FUNCTION pgboss.create_queue(queue_name text, options jsonb)
      RETURNS VOID AS
      $$
      BEGIN
        INSERT INTO pgboss.queue (
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
          false,
          'job',
          (options->>'heartbeatSeconds')::int
        )
        ON CONFLICT DO NOTHING;
      END;
      $$
      LANGUAGE plpgsql;
    ;

    CREATE FUNCTION pgboss.delete_queue(queue_name text)
    RETURNS VOID AS
    $$
    BEGIN
      DELETE FROM pgboss.job WHERE name = queue_name;
      DELETE FROM pgboss.queue WHERE name = queue_name;
    END;
    $$
    LANGUAGE plpgsql;
  ;
INSERT INTO pgboss.version(version) VALUES ('37');
    COMMIT;
  

=== createTableWarning ===

    CREATE TABLE pgboss.warning (
      id uuid PRIMARY KEY default gen_random_uuid(),
      type text NOT NULL,
      message text NOT NULL,
      data jsonb,
      created_on timestamp with time zone NOT NULL DEFAULT now()
    )
  

=== createIndexWarning ===
CREATE INDEX warning_i1 ON pgboss.warning (created_on DESC)

=== createTableJobDependency ===

    CREATE TABLE pgboss.job_dependency (
      child_name text NOT NULL,
      child_id uuid NOT NULL,
      parent_name text NOT NULL,
      parent_id uuid NOT NULL,
      PRIMARY KEY (child_name, child_id, parent_name, parent_id)
    )
  

=== createIndexJobDependencyParent ===
CREATE INDEX IF NOT EXISTS job_dep_parent_idx ON pgboss.job_dependency (parent_name, parent_id)

=== jobTableFormatFunction ===

    CREATE FUNCTION pgboss.job_table_format(command text, table_name text)
    RETURNS text AS
    $$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $$
    LANGUAGE sql IMMUTABLE;
  

=== createQueue ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgbosscreate-queue')::bytea), 'hex'))::bit(64)::bigint
  );
SELECT pgboss.create_queue('q1', '{"policy":"standard","retryLimit":2}'::jsonb);
    COMMIT;
  

=== createQueue noAdvisoryLocks ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pgboss.create_queue('q1', '{"policy":"standard","retryLimit":2}'::jsonb);
    COMMIT;
  

=== notifyChannelSql ===
('pgboss_' || left(encode(sha224('pgboss'::bytea), 'hex'), 24))

=== notifyQueue ===
SELECT pg_notify(('pgboss_' || left(encode(sha224('pgboss'::bytea), 'hex'), 24)), 'q1')

=== deleteQueue ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgbossdelete-queue')::bytea), 'hex'))::bit(64)::bigint
  );
SELECT pgboss.delete_queue('q1');
    COMMIT;
  

=== deleteQueue noAdvisoryLocks ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pgboss.delete_queue('q1');
    COMMIT;
  

=== trySetQueueMonitorTime ===

    UPDATE pgboss.queue
    SET monitor_on = now()
    WHERE name = ANY($1::text[])
      AND EXTRACT( EPOCH FROM (now() - COALESCE(monitor_on, now() - interval '1 week') ) ) > 60
    RETURNING name
  
-- values: [["q1","q2"]]

=== trySetQueueDeletionTime ===

    UPDATE pgboss.queue
    SET maintain_on = now()
    WHERE name = ANY($1::text[])
      AND EXTRACT( EPOCH FROM (now() - COALESCE(maintain_on, now() - interval '1 week') ) ) > 60
    RETURNING name
  
-- values: [["q1","q2"]]

=== trySetCronTime ===

    UPDATE pgboss.version
    SET cron_on = now()
    WHERE EXTRACT( EPOCH FROM (now() - COALESCE(cron_on, now() - interval '1 week') ) ) > 60
    RETURNING true
  

=== trySetBamTime ===

    UPDATE pgboss.version
    SET bam_on = now()
    WHERE EXTRACT( EPOCH FROM (now() - COALESCE(bam_on, now() - interval '1 week') ) ) > 60
    RETURNING true
  

=== trySetFlowTime ===

    UPDATE pgboss.version
    SET flow_on = now()
    WHERE EXTRACT( EPOCH FROM (now() - COALESCE(flow_on, now() - interval '1 week') ) ) > 60
    RETURNING true
  

=== updateQueue ===

    WITH options as (SELECT $2::jsonb as data)
    UPDATE pgboss.queue SET
      retry_limit = COALESCE((o.data->>'retryLimit')::int, retry_limit),
      retry_delay = COALESCE((o.data->>'retryDelay')::int, retry_delay),
      retry_backoff = COALESCE((o.data->>'retryBackoff')::bool, retry_backoff),
      retry_delay_max = CASE WHEN jsonb_exists(o.data, 'retryDelayMax')
        THEN (o.data->>'retryDelayMax')::int
        ELSE retry_delay_max END,
      expire_seconds = COALESCE((o.data->>'expireInSeconds')::int, expire_seconds),
      retention_seconds = COALESCE((o.data->>'retentionSeconds')::int, retention_seconds),
      deletion_seconds = COALESCE((o.data->>'deleteAfterSeconds')::int, deletion_seconds),
      warning_queued = COALESCE((o.data->>'warningQueueSize')::int, warning_queued),
      heartbeat_seconds = CASE WHEN jsonb_exists(o.data, 'heartbeatSeconds')
        THEN (o.data->>'heartbeatSeconds')::int
        ELSE heartbeat_seconds END,
      notify = COALESCE((o.data->>'notify')::bool, notify),
      
      updated_on = now()
    FROM options o
    WHERE name = $1
  

=== updateQueue deadLetter ===

    WITH options as (SELECT $2::jsonb as data)
    UPDATE pgboss.queue SET
      retry_limit = COALESCE((o.data->>'retryLimit')::int, retry_limit),
      retry_delay = COALESCE((o.data->>'retryDelay')::int, retry_delay),
      retry_backoff = COALESCE((o.data->>'retryBackoff')::bool, retry_backoff),
      retry_delay_max = CASE WHEN jsonb_exists(o.data, 'retryDelayMax')
        THEN (o.data->>'retryDelayMax')::int
        ELSE retry_delay_max END,
      expire_seconds = COALESCE((o.data->>'expireInSeconds')::int, expire_seconds),
      retention_seconds = COALESCE((o.data->>'retentionSeconds')::int, retention_seconds),
      deletion_seconds = COALESCE((o.data->>'deleteAfterSeconds')::int, deletion_seconds),
      warning_queued = COALESCE((o.data->>'warningQueueSize')::int, warning_queued),
      heartbeat_seconds = CASE WHEN jsonb_exists(o.data, 'heartbeatSeconds')
        THEN (o.data->>'heartbeatSeconds')::int
        ELSE heartbeat_seconds END,
      notify = COALESCE((o.data->>'notify')::bool, notify),
      dead_letter = CASE WHEN 'dlq' IS DISTINCT FROM dead_letter THEN 'dlq' ELSE dead_letter END,
      updated_on = now()
    FROM options o
    WHERE name = $1
  

=== getQueues ===

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
    FROM pgboss.queue q
    
   
-- values: []

=== getQueues by names ===

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
    FROM pgboss.queue q
    WHERE q.name = ANY($1::text[])
   
-- values: [["q1","q2"]]

=== deleteJobsById ===

    WITH results as (
      DELETE FROM pgboss.job
      WHERE name = $1
        AND id = ANY($2::uuid[])
      RETURNING 1
    )
    SELECT COUNT(*) from results
  

=== deleteQueuedJobs ===
DELETE from pgboss.job WHERE name = $1 and state < 'active'

=== deleteStoredJobs ===
DELETE from pgboss.job WHERE name = $1 and state > 'active'

=== truncateTable ===
TRUNCATE pgboss.job

=== deleteAllJobs ===
DELETE from pgboss.job WHERE name = $1

=== getSchedules ===
SELECT * FROM pgboss.schedule ORDER BY name, key

=== getSchedulesByQueue ===
SELECT * FROM pgboss.schedule WHERE name = $1 ORDER BY key

=== getSchedulesByQueueAndKey ===
SELECT * FROM pgboss.schedule WHERE name = $1 AND COALESCE(key, '') = $2

=== schedule ===

    INSERT INTO pgboss.schedule (name, key, cron, timezone, data, options)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (name, key) DO UPDATE SET
      cron = EXCLUDED.cron,
      timezone = EXCLUDED.timezone,
      data = EXCLUDED.data,
      options = EXCLUDED.options,
      updated_on = now()
  

=== unschedule ===

    DELETE FROM pgboss.schedule
    WHERE name = $1
      AND COALESCE(key, '') = $2
  

=== subscribe ===

    INSERT INTO pgboss.subscription (event, name)
    VALUES ($1, $2)
    ON CONFLICT (event, name) DO UPDATE SET
      event = EXCLUDED.event,
      name = EXCLUDED.name,
      updated_on = now()
  

=== unsubscribe ===

    DELETE FROM pgboss.subscription
    WHERE event = $1 and name = $2
  

=== getQueuesForEvent ===

    SELECT name FROM pgboss.subscription
    WHERE event = $1
  

=== getTime ===
SELECT round(date_part('epoch', now()) * 1000) as time

=== insertWarning ===

    INSERT INTO pgboss.warning (type, message, data)
    VALUES ($1, $2, $3)
  

=== getWarnings ===

    SELECT
      id,
      type,
      message,
      data,
      created_on as "createdOn"
    FROM pgboss.warning
    WHERE ($1::text IS NULL OR type = $1)
    ORDER BY created_on DESC
    LIMIT $2 OFFSET $3
  

=== getWarningsCount ===

    SELECT COUNT(*)::int as count
    FROM pgboss.warning
    WHERE ($1::text IS NULL OR type = $1)
  

=== deleteOldWarnings ===

    DELETE FROM pgboss.warning
    WHERE created_on < now() - interval '30 days'
  

=== createTableQueueStats ===

    CREATE TABLE pgboss.queue_stats (
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
  

=== createTableQueueStats noPartitioning ===

    CREATE TABLE pgboss.queue_stats (
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
  

=== createIndexQueueStats ===
CREATE INDEX queue_stats_i1 ON pgboss.queue_stats (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count)

=== createIndexQueueStats noCoveringIndex ===
CREATE INDEX queue_stats_i1 ON pgboss.queue_stats (name, captured_on DESC) 

=== ensureQueueStatsPartitions ===

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
          WHERE n.nspname = 'pgboss' AND c.relname = part_name
        ) THEN
          EXECUTE format(
            'CREATE TABLE pgboss.%I PARTITION OF pgboss.queue_stats FOR VALUES FROM (%L) TO (%L)',
            part_name,
            to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00',
            to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00'
          );
        END IF;
      END LOOP;
    END;
    $$
  

=== dropOldQueueStatsPartitions ===

    DO $$
    DECLARE
      r record;
      cutoff date := (now() AT TIME ZONE 'UTC')::date - 30;
      suffix text;
      part_date date;
    BEGIN
      FOR r IN
        SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = p.relnamespace
        WHERE n.nspname = 'pgboss' AND p.relname = 'queue_stats'
      LOOP
        suffix := substring(r.relname FROM 'queue_stats_(.*)$');
        IF suffix ~ '^[0-9]{8}$' THEN
          part_date := to_date(suffix, 'YYYYMMDD');
          IF part_date < cutoff THEN
            EXECUTE 'DROP TABLE IF EXISTS pgboss.' || quote_ident(r.relname);
          END IF;
        END IF;
      END LOOP;
    END;
    $$
  

=== deleteOldQueueStats ===

    DELETE FROM pgboss.queue_stats
    WHERE captured_on < now() - interval '30 days'
  

=== insertQueueStats ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgbossqueue-stats-insert')::bytea), 'hex'))::bit(64)::bigint
  );

    INSERT INTO pgboss.queue_stats
      (name, deferred_count, queued_count, ready_count, active_count, failed_count, total_count)
    SELECT name, deferred_count, queued_count, ready_count, active_count, failed_count, total_count
    FROM pgboss.queue
    WHERE name = ANY(ARRAY['q1','q2']::text[])
  ;
    COMMIT;
  

=== insertQueueStats noAdvisoryLocks ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    
    INSERT INTO pgboss.queue_stats
      (name, deferred_count, queued_count, ready_count, active_count, failed_count, total_count)
    SELECT name, deferred_count, queued_count, ready_count, active_count, failed_count, total_count
    FROM pgboss.queue
    WHERE name = ANY(ARRAY['q1','q2']::text[])
  ;
    COMMIT;
  

=== getQueueStatsCache ===

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
    FROM pgboss.queue
    WHERE name = $1
  

=== getQueueStatsHistory ===

    SELECT
      name,
      deferred_count as "deferredCount",
      queued_count   as "queuedCount",
      ready_count    as "readyCount",
      active_count   as "activeCount",
      failed_count   as "failedCount",
      total_count    as "totalCount",
      captured_on    as "capturedOn"
    FROM pgboss.queue_stats
    WHERE name = $1
      AND ($2::timestamptz IS NULL OR captured_on >= $2)
      AND ($3::timestamptz IS NULL OR captured_on <= $3)
    ORDER BY captured_on DESC
    LIMIT $4
  

=== getQueueStatsHistoryBucketed max bucket ===

    WITH w AS (SELECT greatest($5, 1)::bigint AS secs)
    SELECT
      to_timestamp(floor(extract(epoch from captured_on) / w.secs) * w.secs) as "capturedOn",
      max(deferred_count)::int as "deferredCount",
      max(queued_count)::int   as "queuedCount",
      max(ready_count)::int    as "readyCount",
      max(active_count)::int   as "activeCount",
      max(failed_count)::int   as "failedCount",
      max(total_count)::int    as "totalCount"
    FROM pgboss.queue_stats, w
    WHERE name = $1
      AND ($2::timestamptz IS NULL OR captured_on >= $2)
      AND ($3::timestamptz IS NULL OR captured_on <= $3)
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT $4
  

=== getQueueStatsHistoryBucketed min bucket ===

    WITH w AS (SELECT greatest($5, 1)::bigint AS secs)
    SELECT
      to_timestamp(floor(extract(epoch from captured_on) / w.secs) * w.secs) as "capturedOn",
      min(deferred_count)::int as "deferredCount",
      min(queued_count)::int   as "queuedCount",
      min(ready_count)::int    as "readyCount",
      min(active_count)::int   as "activeCount",
      min(failed_count)::int   as "failedCount",
      min(total_count)::int    as "totalCount"
    FROM pgboss.queue_stats, w
    WHERE name = $1
      AND ($2::timestamptz IS NULL OR captured_on >= $2)
      AND ($3::timestamptz IS NULL OR captured_on <= $3)
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT $4
  

=== getQueueStatsHistoryBucketed avg auto ===

    WITH extent AS (
         SELECT min(captured_on) AS lo, max(captured_on) AS hi
         FROM pgboss.queue_stats
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
       )
    SELECT
      to_timestamp(floor(extract(epoch from captured_on) / w.secs) * w.secs) as "capturedOn",
      round(avg(deferred_count))::int as "deferredCount",
      round(avg(queued_count))::int   as "queuedCount",
      round(avg(ready_count))::int    as "readyCount",
      round(avg(active_count))::int   as "activeCount",
      round(avg(failed_count))::int   as "failedCount",
      round(avg(total_count))::int    as "totalCount"
    FROM pgboss.queue_stats, w
    WHERE name = $1
      AND ($2::timestamptz IS NULL OR captured_on >= $2)
      AND ($3::timestamptz IS NULL OR captured_on <= $3)
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT least($4, $5)
  

=== getVersion ===
SELECT version from pgboss.version

=== setVersion ===
UPDATE pgboss.version SET version = '37'

=== versionTableExists ===
SELECT to_regclass('pgboss.version') as name

=== getSchemaCaseVariants ===

    SELECT n.nspname as name
    FROM pg_namespace n
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'version' AND c.relkind IN ('r', 'p')
    WHERE lower(n.nspname) = lower('pgboss') AND n.nspname <> 'pgboss'
    ORDER BY n.nspname
  

=== getPartitionedQueueTables ===
SELECT table_name FROM pgboss.queue WHERE partition = true

=== insertVersion ===
INSERT INTO pgboss.version(version) VALUES ('37')

=== fetchNextJob base ===

      WITH
      
      
      next AS (
        SELECT j.id
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM next
      WHERE name = 'q1' AND j.id = next.id
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: []

=== fetchNextJob noSkipLocked ===

      WITH
      
      
      next AS (
        SELECT j.id
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        
      )
      
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM next
      WHERE name = 'q1' AND j.id = next.id
      
      AND j.state < 'active'
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: []

=== fetchNextJob metadata ===

      WITH
      
      
      next AS (
        SELECT j.id
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM next
      WHERE name = 'q1' AND j.id = next.id
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier",
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

    
-- values: []

=== fetchNextJob singleton batch ===

      WITH
      
      
      next AS (
        SELECT j.id, j.singleton_key
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 5
        FOR UPDATE OF j SKIP LOCKED
      )
      , singleton_ranking AS (
        SELECT id, 
          row_number() OVER (PARTITION BY singleton_key) as singleton_rn
        FROM next
      )
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM singleton_ranking
      WHERE name = 'q1' AND j.id = singleton_ranking.id
      AND singleton_rn = 1
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: []

=== fetchNextJob stately batch ===

      WITH
      
      
      next AS (
        SELECT j.id, j.singleton_key
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 5
        FOR UPDATE OF j SKIP LOCKED
      )
      , singleton_ranking AS (
        SELECT id, 
          row_number() OVER (PARTITION BY singleton_key) as singleton_rn
        FROM next
      )
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM singleton_ranking
      WHERE name = 'q1' AND j.id = singleton_ranking.id
      AND singleton_rn = 1
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: []

=== fetchNextJob exclusive ===

      WITH
      
      
      next AS (
        SELECT j.id
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM next
      WHERE name = 'q1' AND j.id = next.id
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: []

=== fetchNextJob key_strict_fifo ===

      WITH
      
      
      next AS (
        SELECT j.id
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM next
      WHERE name = 'q1' AND j.id = next.id
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: []

=== fetchNextJob no priority no order ignoreStartAfter ===

      WITH
      
      
      next AS (
        SELECT j.id
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
        ORDER BY j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM next
      WHERE name = 'q1' AND j.id = next.id
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: []

=== fetchNextJob ignoreSingletons ===

      WITH
      
      
      next AS (
        SELECT j.id
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
          AND COALESCE(j.singleton_key, '') <> ALL($1::text[])
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM next
      WHERE name = 'q1' AND j.id = next.id
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: [["a","b"]]

=== fetchNextJob ignoreGroups ===

      WITH
      
      
      next AS (
        SELECT j.id
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
          AND (j.group_id IS NULL OR j.group_id <> ALL($1::text[]))
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM next
      WHERE name = 'q1' AND j.id = next.id
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: [["g1"]]

=== fetchNextJob groupConcurrency single ===

      WITH
      
      
      next AS (
        SELECT j.id, j.group_id, j.group_tier
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
          AND (j.group_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM pgboss.job active_group_probe
              WHERE active_group_probe.name = 'q1'
                AND active_group_probe.state = 'active'
                AND active_group_probe.group_id IS NOT NULL
                AND active_group_probe.group_id = j.group_id
            ))
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      ,
      group_ranking AS (
        SELECT t.id
          , t.group_id
          , t.group_tier
          
          , ROW_NUMBER() OVER (PARTITION BY t.group_id ORDER BY t.id) as group_rn
          , 0 as active_cnt
        FROM next t
        
      ),
      group_filtered AS (
        SELECT id FROM group_ranking
        WHERE group_id IS NULL
          OR (active_cnt + group_rn) <= $1::int
      )
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      
      WHERE name = 'q1' AND j.id = ANY (ARRAY(SELECT id FROM group_filtered))
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: [1]

=== fetchNextJob groupConcurrency tiers ===

      WITH
      active_group_count_map AS MATERIALIZED (
        SELECT COALESCE(jsonb_object_agg(group_id, active_cnt), '{}'::jsonb) as counts
        FROM (
          SELECT group_id, COUNT(*)::int as active_cnt
          FROM pgboss.job
          WHERE name = 'q1' AND state = 'active' AND group_id IS NOT NULL
          GROUP BY group_id
        ) active_groups
      ), 
      
      next AS (
        SELECT j.id, j.group_id, j.group_tier, COALESCE(((SELECT counts FROM active_group_count_map) ->> j.group_id)::int, 0) as active_cnt
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
          AND (j.group_id IS NULL
            OR COALESCE(((SELECT counts FROM active_group_count_map) ->> j.group_id)::int, 0) < COALESCE(($2::jsonb ->> group_tier)::int, $1::int))
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      ,
      group_ranking AS (
        SELECT t.id
          , t.group_id
          , t.group_tier
          
          , ROW_NUMBER() OVER (PARTITION BY t.group_id ORDER BY t.id) as group_rn
          , t.active_cnt as active_cnt
        FROM next t
        
      ),
      group_filtered AS (
        SELECT id FROM group_ranking
        WHERE group_id IS NULL
          OR (active_cnt + group_rn) <= COALESCE(($2::jsonb ->> group_tier)::int, $1::int)
      )
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      
      WHERE name = 'q1' AND j.id = ANY (ARRAY(SELECT id FROM group_filtered))
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: [2,"{\"gold\":5}"]

=== fetchNextJob priority bounds ===

      WITH
      
      
      next AS (
        SELECT j.id
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
          AND j.priority >= $1::int
          AND j.priority <= $2::int
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      FROM next
      WHERE name = 'q1' AND j.id = next.id
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier"
    
-- values: [1,9]

=== fetchNextJob kitchen sink ===

      WITH
      active_group_count_map AS MATERIALIZED (
        SELECT COALESCE(jsonb_object_agg(group_id, active_cnt), '{}'::jsonb) as counts
        FROM (
          SELECT group_id, COUNT(*)::int as active_cnt
          FROM pgboss.job
          WHERE name = 'q1' AND state = 'active' AND group_id IS NOT NULL
          GROUP BY group_id
        ) active_groups
      ), 
      
      next AS (
        SELECT j.id, j.group_id, j.group_tier, COALESCE(((SELECT counts FROM active_group_count_map) ->> j.group_id)::int, 0) as active_cnt
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
          AND COALESCE(j.singleton_key, '') <> ALL($1::text[])
          AND (j.group_id IS NULL OR j.group_id <> ALL($2::text[]))
          AND j.priority >= $5::int
          AND j.priority <= $6::int
          AND (j.group_id IS NULL
            OR COALESCE(((SELECT counts FROM active_group_count_map) ->> j.group_id)::int, 0) < COALESCE(($4::jsonb ->> group_tier)::int, $3::int))
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      
      ,
      group_ranking AS (
        SELECT t.id
          , t.group_id
          , t.group_tier
          
          , ROW_NUMBER() OVER (PARTITION BY t.group_id ORDER BY t.id) as group_rn
          , t.active_cnt as active_cnt
        FROM next t
        
      ),
      group_filtered AS (
        SELECT id FROM group_ranking
        WHERE group_id IS NULL
          OR (active_cnt + group_rn) <= COALESCE(($4::jsonb ->> group_tier)::int, $3::int)
      )
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      
      WHERE name = 'q1' AND j.id = ANY (ARRAY(SELECT id FROM group_filtered))
      
      
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier",
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

    
-- values: [["a"],["g1"],2,"{\"gold\":5}",1,9]

=== fetchNextJob kitchen sink noSkipLocked ===

      WITH
      active_group_count_map AS MATERIALIZED (
        SELECT COALESCE(jsonb_object_agg(group_id, active_cnt), '{}'::jsonb) as counts
        FROM (
          SELECT group_id, COUNT(*)::int as active_cnt
          FROM pgboss.job
          WHERE name = 'q1' AND state = 'active' AND group_id IS NOT NULL
          GROUP BY group_id
        ) active_groups
      ), 
      
      next AS (
        SELECT j.id, j.group_id, j.group_tier, COALESCE(((SELECT counts FROM active_group_count_map) ->> j.group_id)::int, 0) as active_cnt
        FROM pgboss.job j
        WHERE j.name = 'q1'
          AND j.state < 'active'
          AND NOT j.blocked
          AND j.start_after <= now()
          AND COALESCE(j.singleton_key, '') <> ALL($1::text[])
          AND (j.group_id IS NULL OR j.group_id <> ALL($2::text[]))
          AND j.priority >= $5::int
          AND j.priority <= $6::int
          AND (j.group_id IS NULL
            OR COALESCE(((SELECT counts FROM active_group_count_map) ->> j.group_id)::int, 0) < COALESCE(($4::jsonb ->> group_tier)::int, $3::int))
        ORDER BY j.priority desc, j.created_on, j.id
        LIMIT 1
        
      )
      
      ,
      group_ranking AS (
        SELECT t.id
          , t.group_id
          , t.group_tier
          
          , ROW_NUMBER() OVER (PARTITION BY t.group_id ORDER BY t.id) as group_rn
          , t.active_cnt as active_cnt
        FROM next t
        
      ),
      group_filtered AS (
        SELECT id FROM group_ranking
        WHERE group_id IS NULL
          OR (active_cnt + group_rn) <= COALESCE(($4::jsonb ->> group_tier)::int, $3::int)
      )
      UPDATE pgboss.job j SET
        state = 'active',
        started_on = now(),
        heartbeat_on = now(),
        retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END
      
      WHERE name = 'q1' AND j.id = ANY (ARRAY(SELECT id FROM group_filtered))
      
      AND j.state < 'active'
      RETURNING j.id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier",
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

    
-- values: [["a"],["g1"],2,"{\"gold\":5}",1,9]

=== completeJobs ===

    WITH results AS (
      UPDATE pgboss.job
      SET completed_on = now(),
        state = 'completed',
        output = $3::jsonb,
        blocked = blocked,
        pending_dependencies = pending_dependencies
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state = 'active'
      RETURNING 1
    )
    SELECT COUNT(*) FROM results
  

=== completeJobs includeQueued ===

    WITH results AS (
      UPDATE pgboss.job
      SET completed_on = now(),
        state = 'completed',
        output = $3::jsonb,
        blocked = false,
        pending_dependencies = 0
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state < 'completed'
      RETURNING 1
    )
    SELECT COUNT(*) FROM results
  

=== completeJobsWithOutputs ===

    WITH input AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    ),
    results AS (
      UPDATE pgboss.job j
      SET completed_on = now(),
        state = 'completed',
        output = i.output
      FROM input i
      WHERE j.name = $1
        AND j.id = i.id
        AND j.state = 'active'
      RETURNING 1
    )
    SELECT COUNT(*) FROM results
  

=== completeJobsWithOutputsDistributed ===

    WITH input AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    )
    UPDATE pgboss.job j
    SET completed_on = now(),
      state = 'completed',
      output = i.output
    FROM input i
    WHERE j.name = $1
      AND j.id = i.id
      AND j.state = 'active'
    RETURNING j.id
  

=== completeJobsDistributed ===

    UPDATE pgboss.job
      SET completed_on = now(),
        state = 'completed',
        output = $3::jsonb,
        blocked = blocked,
        pending_dependencies = pending_dependencies
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state = 'active'
    RETURNING id
  

=== completeJobsDistributed includeQueued ===

    UPDATE pgboss.job
      SET completed_on = now(),
        state = 'completed',
        output = $3::jsonb,
        blocked = false,
        pending_dependencies = 0
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state < 'completed'
    RETURNING id
  

=== cancelJobs ===

    WITH results as (
      UPDATE pgboss.job
      SET completed_on = now(),
        state = 'cancelled'
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state < 'completed'
      RETURNING 1
    )
    SELECT COUNT(*) from results
  

=== resumeJobs ===

    WITH results as (
      UPDATE pgboss.job
      SET completed_on = NULL,
        state = 'created'
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state = 'cancelled'
      RETURNING 1
    )
    SELECT COUNT(*) from results
  

=== restoreJobs ===

    UPDATE pgboss.job
    SET state = 'created',
        started_on = NULL,
        heartbeat_on = NULL
    WHERE name = $1
      AND id = ANY($2::uuid[])
  

=== insertJobs ===

    INSERT INTO pgboss.job (
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
      'q1' as name,
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
    JOIN pgboss.queue q ON q.name = 'q1'
    ON CONFLICT DO NOTHING
    RETURNING id
  

=== insertJobs no returnId ===

    INSERT INTO pgboss.job (
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
      'q1' as name,
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
    JOIN pgboss.queue q ON q.name = 'q1'
    ON CONFLICT DO NOTHING
    
  

=== insertJobs notify ===

    WITH ins AS (
      
    INSERT INTO pgboss.job (
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
      'q1' as name,
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
    JOIN pgboss.queue q ON q.name = 'q1'
    ON CONFLICT DO NOTHING
    RETURNING id, start_after
  
    ),
    notified AS (
      SELECT pg_notify(('pgboss_' || left(encode(sha224('pgboss'::bytea), 'hex'), 24)), 'q1')
      FROM ins WHERE start_after <= now() LIMIT 1
    )
    SELECT id FROM ins WHERE (SELECT count(*) FROM notified) >= 0
  

=== insertFlowJobs ===

    WITH ins AS (
      
    INSERT INTO pgboss.job (
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
      'q1' as name,
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
      FROM json_to_recordset('[{"id":"a"},{"id":"b"}]'::json) as x (
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
    JOIN pgboss.queue q ON q.name = 'q1'
    ON CONFLICT DO NOTHING
    RETURNING id
  
    )
    SELECT 1 / (CASE WHEN (SELECT count(*) FROM ins) = 2 THEN 1 ELSE 0 END)
  

=== failJobsById ===

    WITH deleted_jobs AS (
      DELETE FROM pgboss.job
      WHERE name = $1 AND id = ANY($2::uuid[]) AND state < 'completed'
      RETURNING *
    ),
    retried_jobs AS (
      INSERT INTO pgboss.job (
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
        CASE
          WHEN retry_count < retry_limit THEN 'retry'::pgboss.job_state
          ELSE 'failed'::pgboss.job_state
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
        CASE WHEN retry_count < retry_limit THEN NULL ELSE now() END as completed_on,
        keep_until,
        policy,
        $3::jsonb,
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
      INSERT INTO pgboss.job (
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
        'failed'::pgboss.job_state as state,
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
        $3::jsonb,
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
      INSERT INTO pgboss.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
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
        JOIN pgboss.queue q ON q.name = r.dead_letter
      WHERE state = 'failed'
    )
    SELECT COUNT(*) FROM results
  

=== failJobsByTimeout ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgbossjobfailJobsByTimeout')::bytea), 'hex'))::bit(64)::bigint
  );

    WITH deleted_jobs AS (
      DELETE FROM pgboss.job
      WHERE state = 'active'
            AND (started_on + expire_seconds * interval '1s') < now()
            AND name = ANY(ARRAY['q1','q2']::text[])
      RETURNING *
    ),
    retried_jobs AS (
      INSERT INTO pgboss.job (
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
        CASE
          WHEN retry_count < retry_limit THEN 'retry'::pgboss.job_state
          ELSE 'failed'::pgboss.job_state
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
        CASE WHEN retry_count < retry_limit THEN NULL ELSE now() END as completed_on,
        keep_until,
        policy,
        '{ "value": { "message": "job timed out" } }'::jsonb,
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
      INSERT INTO pgboss.job (
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
        'failed'::pgboss.job_state as state,
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
        '{ "value": { "message": "job timed out" } }'::jsonb,
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
      INSERT INTO pgboss.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
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
        JOIN pgboss.queue q ON q.name = r.dead_letter
      WHERE state = 'failed'
    )
    SELECT COUNT(*) FROM results
  ;
    COMMIT;
  

=== failJobsByTimeout noAdvisoryLocks ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    
    WITH deleted_jobs AS (
      DELETE FROM pgboss.job
      WHERE state = 'active'
            AND (started_on + expire_seconds * interval '1s') < now()
            AND name = ANY(ARRAY['q1','q2']::text[])
      RETURNING *
    ),
    retried_jobs AS (
      INSERT INTO pgboss.job (
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
        CASE
          WHEN retry_count < retry_limit THEN 'retry'::pgboss.job_state
          ELSE 'failed'::pgboss.job_state
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
        CASE WHEN retry_count < retry_limit THEN NULL ELSE now() END as completed_on,
        keep_until,
        policy,
        '{ "value": { "message": "job timed out" } }'::jsonb,
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
      INSERT INTO pgboss.job (
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
        'failed'::pgboss.job_state as state,
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
        '{ "value": { "message": "job timed out" } }'::jsonb,
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
      INSERT INTO pgboss.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
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
        JOIN pgboss.queue q ON q.name = r.dead_letter
      WHERE state = 'failed'
    )
    SELECT COUNT(*) FROM results
  ;
    COMMIT;
  

=== failJobsByHeartbeat ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgbossjobfailJobsByHeartbeat')::bytea), 'hex'))::bit(64)::bigint
  );

    WITH deleted_jobs AS (
      DELETE FROM pgboss.job
      WHERE state = 'active'
            AND heartbeat_seconds IS NOT NULL
            AND (heartbeat_on + heartbeat_seconds * interval '1s') < now()
            AND name = ANY(ARRAY['q1','q2']::text[])
      RETURNING *
    ),
    retried_jobs AS (
      INSERT INTO pgboss.job (
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
        CASE
          WHEN retry_count < retry_limit THEN 'retry'::pgboss.job_state
          ELSE 'failed'::pgboss.job_state
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
        CASE WHEN retry_count < retry_limit THEN NULL ELSE now() END as completed_on,
        keep_until,
        policy,
        '{ "value": { "message": "job heartbeat timeout" } }'::jsonb,
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
      INSERT INTO pgboss.job (
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
        'failed'::pgboss.job_state as state,
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
        '{ "value": { "message": "job heartbeat timeout" } }'::jsonb,
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
      INSERT INTO pgboss.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
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
        JOIN pgboss.queue q ON q.name = r.dead_letter
      WHERE state = 'failed'
    )
    SELECT COUNT(*) FROM results
  ;
    COMMIT;
  

=== failJobsByHeartbeat noAdvisoryLocks ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    
    WITH deleted_jobs AS (
      DELETE FROM pgboss.job
      WHERE state = 'active'
            AND heartbeat_seconds IS NOT NULL
            AND (heartbeat_on + heartbeat_seconds * interval '1s') < now()
            AND name = ANY(ARRAY['q1','q2']::text[])
      RETURNING *
    ),
    retried_jobs AS (
      INSERT INTO pgboss.job (
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
        CASE
          WHEN retry_count < retry_limit THEN 'retry'::pgboss.job_state
          ELSE 'failed'::pgboss.job_state
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
        CASE WHEN retry_count < retry_limit THEN NULL ELSE now() END as completed_on,
        keep_until,
        policy,
        '{ "value": { "message": "job heartbeat timeout" } }'::jsonb,
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
      INSERT INTO pgboss.job (
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
        'failed'::pgboss.job_state as state,
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
        '{ "value": { "message": "job heartbeat timeout" } }'::jsonb,
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
      INSERT INTO pgboss.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
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
        JOIN pgboss.queue q ON q.name = r.dead_letter
      WHERE state = 'failed'
    )
    SELECT COUNT(*) FROM results
  ;
    COMMIT;
  

=== touchJobs ===

    WITH results AS (
      UPDATE pgboss.job
      SET heartbeat_on = now()
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state = 'active'
      RETURNING 1
    )
    SELECT COUNT(*) FROM results
  

=== failJobsByIdWithOutputs ===

    WITH output_map AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    ),
    deleted_jobs AS (
      DELETE FROM pgboss.job
      WHERE name = $1 AND id IN (SELECT id FROM output_map) AND state < 'completed'
      RETURNING *
    ),
    retried_jobs AS (
      INSERT INTO pgboss.job (
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
        CASE
          WHEN retry_count < retry_limit THEN 'retry'::pgboss.job_state
          ELSE 'failed'::pgboss.job_state
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
        CASE WHEN retry_count < retry_limit THEN NULL ELSE now() END as completed_on,
        keep_until,
        policy,
        (SELECT om.output FROM output_map om WHERE om.id = deleted_jobs.id),
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
      INSERT INTO pgboss.job (
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
        'failed'::pgboss.job_state as state,
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
        (SELECT om.output FROM output_map om WHERE om.id = deleted_jobs.id),
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
      INSERT INTO pgboss.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
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
        JOIN pgboss.queue q ON q.name = r.dead_letter
      WHERE state = 'failed'
    )
    SELECT COUNT(*) FROM results
  

=== deadLetterJobsByIdWithOutputs ===

    WITH output_map AS (
      SELECT * FROM json_to_recordset($2::json) AS x (id uuid, output jsonb)
    ),
    deleted_jobs AS (
      DELETE FROM pgboss.job
      WHERE name = $1 AND id IN (SELECT id FROM output_map) AND state < 'completed'
      RETURNING *
    ),
    retried_jobs AS (
      INSERT INTO pgboss.job (
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
        'failed'::pgboss.job_state as state,
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
        now() as completed_on,
        keep_until,
        policy,
        (SELECT om.output FROM output_map om WHERE om.id = deleted_jobs.id),
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
      INSERT INTO pgboss.job (
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
        'failed'::pgboss.job_state as state,
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
        (SELECT om.output FROM output_map om WHERE om.id = deleted_jobs.id),
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
      INSERT INTO pgboss.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
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
        JOIN pgboss.queue q ON q.name = r.dead_letter
      WHERE state = 'failed'
    )
    SELECT COUNT(*) FROM results
  

=== selectJobsToFailById ===
SELECT * FROM pgboss.job WHERE name = $1 AND id = ANY($2::uuid[]) AND state < 'completed'
-- values: []

=== deleteJobsToFail ===
DELETE FROM pgboss.job WHERE name = $1 AND id = ANY($2::uuid[])
-- values: []

=== selectJobsToFailByTimeout ===
SELECT * FROM pgboss.job
      WHERE state = 'active'
        AND (started_on + expire_seconds * interval '1s') < now()
        AND name = ANY(ARRAY['q1','q2']::text[])
-- values: []

=== selectJobsToFailByHeartbeat ===
SELECT * FROM pgboss.job
      WHERE state = 'active'
        AND heartbeat_seconds IS NOT NULL
        AND (heartbeat_on + heartbeat_seconds * interval '1s') < now()
        AND name = ANY(ARRAY['q1','q2']::text[])
-- values: []

=== deleteJobsByIds ===
DELETE FROM pgboss.job WHERE id = ANY($1::uuid[])
-- values: []

=== decrementDependents ===

    WITH decremented AS (
      SELECT d.child_name, d.child_id, COUNT(*)::int AS n
      FROM pgboss.job_dependency d
      WHERE d.parent_name = $1
        AND d.parent_id = ANY($2::uuid[])
      GROUP BY d.child_name, d.child_id
    ),
    locked_children AS (
      SELECT j.name, j.id, d.n
      FROM pgboss.job j
      JOIN decremented d ON d.child_name = j.name
        AND d.child_id = j.id
      WHERE j.blocked
      ORDER BY j.name, j.id
      FOR UPDATE OF j
    )
    UPDATE pgboss.job j
      SET pending_dependencies = GREATEST(j.pending_dependencies - lc.n, 0),
          blocked = GREATEST(j.pending_dependencies - lc.n, 0) > 0
      FROM locked_children lc
      WHERE j.name = lc.name
        AND j.id = lc.id
  

=== resolveFlowJobs ===

    WITH locked_parents AS (
      SELECT j.name, j.id
      FROM pgboss.job j
      WHERE j.blocking
        AND j.state = 'completed'
        AND j.name = ANY($1::text[])
      ORDER BY j.name, j.id
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1000
    ),
    decremented AS (
      SELECT d.child_name, d.child_id, COUNT(*)::int AS n
      FROM pgboss.job_dependency d
      JOIN locked_parents p ON d.parent_name = p.name
        AND d.parent_id = p.id
      GROUP BY d.child_name, d.child_id
    ),
    locked_children AS (
      SELECT j.name, j.id, d.n
      FROM pgboss.job j
      JOIN decremented d ON d.child_name = j.name
        AND d.child_id = j.id
      WHERE j.blocked
      ORDER BY j.name, j.id
      FOR UPDATE OF j
    ),
    unblocked AS (
      UPDATE pgboss.job j
      SET pending_dependencies = GREATEST(j.pending_dependencies - lc.n, 0),
          blocked = GREATEST(j.pending_dependencies - lc.n, 0) > 0
      FROM locked_children lc
      WHERE j.name = lc.name
        AND j.id = lc.id
      RETURNING 1
    ),
    cleared AS (
      UPDATE pgboss.job j
      SET blocking = false
      FROM locked_parents p
      WHERE j.name = p.name
        AND j.id = p.id
      RETURNING 1
    )
    SELECT COUNT(*)::int AS resolved FROM cleared
  
-- values: [["q1","q2"]]

=== selectBlockingParents ===

      SELECT name, id
      FROM pgboss.job
      WHERE blocking
        AND state = 'completed'
        AND name = ANY($1::text[])
      ORDER BY name, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    
-- values: [["q1","q2"]]

=== selectBlockingParents noSkipLocked ===

      SELECT name, id
      FROM pgboss.job
      WHERE blocking
        AND state = 'completed'
        AND name = ANY($1::text[])
      ORDER BY name, id
      FOR UPDATE
      LIMIT 1000
    
-- values: [["q1","q2"]]

=== clearBlocking ===

    UPDATE pgboss.job
    SET blocking = false
    WHERE name = $1
      AND id = ANY($2::uuid[])
  

=== insertRetryJob ===

    INSERT INTO pgboss.job (
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
  

=== insertDeadLetterJob ===

    INSERT INTO pgboss.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds,
      expire_seconds, source_name, source_id, source_created_on, source_retry_count, singleton_key, heartbeat_seconds)
    SELECT $1, $2, $3, q.retry_limit, q.retry_backoff, q.retry_delay, now() + q.retention_seconds * interval '1s', q.deletion_seconds,
      q.expire_seconds, $4, $5, $6, $7, $8, $9
    FROM pgboss.queue q WHERE q.name = $1
  

=== redriveJobs ===

    WITH candidates AS (
      SELECT j.id
      FROM pgboss.job j
      JOIN pgboss.queue q ON q.name = COALESCE($2, j.source_name)
      WHERE j.name = $1
        AND j.state < 'active'
        AND ($3::text IS NULL OR j.source_name = $3)
      ORDER BY j.created_on
      LIMIT $4
      FOR UPDATE OF j SKIP LOCKED
    ),
    moved AS (
      DELETE FROM pgboss.job
      WHERE id IN (SELECT id FROM candidates)
      RETURNING *
    ),
    ins AS (
      INSERT INTO pgboss.job
        (name, data, priority, retry_limit, retry_backoff, retry_delay, retry_delay_max,
         expire_seconds, keep_until, deletion_seconds, policy, singleton_key, heartbeat_seconds)
      SELECT COALESCE($2, m.source_name), m.data, m.priority, q.retry_limit, q.retry_backoff,
        q.retry_delay, q.retry_delay_max, q.expire_seconds,
        now() + q.retention_seconds * interval '1s', q.deletion_seconds, q.policy,
        m.singleton_key, m.heartbeat_seconds
      FROM moved m JOIN pgboss.queue q ON q.name = COALESCE($2, m.source_name)
      -- A destination queue's short/stately policy can still collide on (name, singleton_key)
      -- if two redriven jobs share a key (job_i1/job_i3); dropping just that row here, matching
      -- retried_jobs' ON CONFLICT DO NOTHING elsewhere, is preferable to aborting the whole batch.
      -- The dropped job has already been deleted from the DLQ by the moved CTE and is not restored.
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS moved FROM ins
  

=== selectJobsToRedrive ===

      SELECT j.id, j.data, j.priority, j.singleton_key as "singletonKey",
        j.heartbeat_seconds as "heartbeatSeconds", j.source_name as "sourceName"
      FROM pgboss.job j
      JOIN pgboss.queue q ON q.name = COALESCE($2, j.source_name)
      WHERE j.name = $1
        AND j.state < 'active'
        AND ($3::text IS NULL OR j.source_name = $3)
      ORDER BY j.created_on
      LIMIT $4
    
-- values: []

=== insertRedriveJob ===

    INSERT INTO pgboss.job
      (name, data, priority, retry_limit, retry_backoff, retry_delay, retry_delay_max,
       expire_seconds, keep_until, deletion_seconds, policy, singleton_key, heartbeat_seconds)
    SELECT q.name, $2, $3, q.retry_limit, q.retry_backoff, q.retry_delay, q.retry_delay_max,
      q.expire_seconds, now() + q.retention_seconds * interval '1s', q.deletion_seconds, q.policy, $4, $5
    FROM pgboss.queue q WHERE q.name = $1
    ON CONFLICT DO NOTHING
    RETURNING id
  

=== deletion ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgbossjobdeletion')::bytea), 'hex'))::bit(64)::bigint
  );

    DELETE FROM pgboss.job
    WHERE name = ANY(ARRAY['q1','q2']::text[])
      AND
      (
        (deletion_seconds > 0 AND completed_on + deletion_seconds * interval '1s' < now())
        OR
        (state < 'active' AND keep_until < now())
      )
  ;
    COMMIT;
  

=== deletion noAdvisoryLocks ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    
    DELETE FROM pgboss.job
    WHERE name = ANY(ARRAY['q1','q2']::text[])
      AND
      (
        (deletion_seconds > 0 AND completed_on + deletion_seconds * interval '1s' < now())
        OR
        (state < 'active' AND keep_until < now())
      )
  ;
    COMMIT;
  

=== retryJobs ===

    WITH results as (
      UPDATE pgboss.job
      SET state = 'retry',
        retry_limit = retry_limit + 1,
        completed_on = NULL
      WHERE name = $1
        AND id = ANY($2::uuid[])
        AND state = 'failed'
      RETURNING 1
    )
    SELECT COUNT(*) from results
  

=== updateJob by id ===

    WITH o AS (SELECT $1::jsonb AS data),
    target AS (
      SELECT job.id
      FROM pgboss.job job, o
      WHERE job.name = 'q1'
        AND job.state < 'active'
        AND job.id = (o.data->>'id')::uuid
      
    ),
    upd AS (
      UPDATE pgboss.job job
      SET data = CASE WHEN jsonb_exists(o.data, 'data') THEN o.data->'data' ELSE job.data END,
          priority = COALESCE((o.data->>'priority')::int, job.priority),
          start_after = 
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END,
          keep_until = CASE
            WHEN jsonb_exists(o.data, 'retentionSeconds')
              THEN (
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END) + ((o.data->>'retentionSeconds')::int * interval '1s')
            -- When only start_after moves, slide keep_until by the same original retention window
            -- (keep_until - start_after) so pulling a job forward/back never leaves keep_until in
            -- the past, which the deletion sweep would treat as expired and remove the pending job.
            WHEN jsonb_exists(o.data, 'startAfter')
              THEN (
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END) + (job.keep_until - job.start_after)
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
        AND job.state < 'active'
      RETURNING job.id, job.start_after
    )
    SELECT id FROM upd
  

=== updateJob by id notify ===

    WITH o AS (SELECT $1::jsonb AS data),
    target AS (
      SELECT job.id
      FROM pgboss.job job, o
      WHERE job.name = 'q1'
        AND job.state < 'active'
        AND job.id = (o.data->>'id')::uuid
      
    ),
    upd AS (
      UPDATE pgboss.job job
      SET data = CASE WHEN jsonb_exists(o.data, 'data') THEN o.data->'data' ELSE job.data END,
          priority = COALESCE((o.data->>'priority')::int, job.priority),
          start_after = 
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END,
          keep_until = CASE
            WHEN jsonb_exists(o.data, 'retentionSeconds')
              THEN (
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END) + ((o.data->>'retentionSeconds')::int * interval '1s')
            -- When only start_after moves, slide keep_until by the same original retention window
            -- (keep_until - start_after) so pulling a job forward/back never leaves keep_until in
            -- the past, which the deletion sweep would treat as expired and remove the pending job.
            WHEN jsonb_exists(o.data, 'startAfter')
              THEN (
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END) + (job.keep_until - job.start_after)
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
        AND job.state < 'active'
      RETURNING job.id, job.start_after
    ), notified AS (
      SELECT pg_notify(('pgboss_' || left(encode(sha224('pgboss'::bytea), 'hex'), 24)), 'q1')
      FROM upd WHERE start_after <= now() LIMIT 1
    )
    SELECT id FROM upd WHERE (SELECT count(*) FROM notified) >= 0
  

=== updateJob by key newest ===

    WITH o AS (SELECT $1::jsonb AS data),
    target AS (
      SELECT job.id
      FROM pgboss.job job, o
      WHERE job.name = 'q1'
        AND job.state < 'active'
        AND job.singleton_key = o.data->>'singletonKey'
      ORDER BY job.created_on DESC LIMIT 1
    ),
    upd AS (
      UPDATE pgboss.job job
      SET data = CASE WHEN jsonb_exists(o.data, 'data') THEN o.data->'data' ELSE job.data END,
          priority = COALESCE((o.data->>'priority')::int, job.priority),
          start_after = 
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END,
          keep_until = CASE
            WHEN jsonb_exists(o.data, 'retentionSeconds')
              THEN (
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END) + ((o.data->>'retentionSeconds')::int * interval '1s')
            -- When only start_after moves, slide keep_until by the same original retention window
            -- (keep_until - start_after) so pulling a job forward/back never leaves keep_until in
            -- the past, which the deletion sweep would treat as expired and remove the pending job.
            WHEN jsonb_exists(o.data, 'startAfter')
              THEN (
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END) + (job.keep_until - job.start_after)
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
        AND job.state < 'active'
      RETURNING job.id, job.start_after
    )
    SELECT id FROM upd
  

=== updateJob by key oldest ===

    WITH o AS (SELECT $1::jsonb AS data),
    target AS (
      SELECT job.id
      FROM pgboss.job job, o
      WHERE job.name = 'q1'
        AND job.state < 'active'
        AND job.singleton_key = o.data->>'singletonKey'
      ORDER BY job.created_on ASC LIMIT 1
    ),
    upd AS (
      UPDATE pgboss.job job
      SET data = CASE WHEN jsonb_exists(o.data, 'data') THEN o.data->'data' ELSE job.data END,
          priority = COALESCE((o.data->>'priority')::int, job.priority),
          start_after = 
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END,
          keep_until = CASE
            WHEN jsonb_exists(o.data, 'retentionSeconds')
              THEN (
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END) + ((o.data->>'retentionSeconds')::int * interval '1s')
            -- When only start_after moves, slide keep_until by the same original retention window
            -- (keep_until - start_after) so pulling a job forward/back never leaves keep_until in
            -- the past, which the deletion sweep would treat as expired and remove the pending job.
            WHEN jsonb_exists(o.data, 'startAfter')
              THEN (
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END) + (job.keep_until - job.start_after)
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
        AND job.state < 'active'
      RETURNING job.id, job.start_after
    )
    SELECT id FROM upd
  

=== updateJob by key all ===

    WITH o AS (SELECT $1::jsonb AS data),
    target AS (
      SELECT job.id
      FROM pgboss.job job, o
      WHERE job.name = 'q1'
        AND job.state < 'active'
        AND job.singleton_key = o.data->>'singletonKey'
      
    ),
    upd AS (
      UPDATE pgboss.job job
      SET data = CASE WHEN jsonb_exists(o.data, 'data') THEN o.data->'data' ELSE job.data END,
          priority = COALESCE((o.data->>'priority')::int, job.priority),
          start_after = 
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END,
          keep_until = CASE
            WHEN jsonb_exists(o.data, 'retentionSeconds')
              THEN (
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END) + ((o.data->>'retentionSeconds')::int * interval '1s')
            -- When only start_after moves, slide keep_until by the same original retention window
            -- (keep_until - start_after) so pulling a job forward/back never leaves keep_until in
            -- the past, which the deletion sweep would treat as expired and remove the pending job.
            WHEN jsonb_exists(o.data, 'startAfter')
              THEN (
        CASE WHEN jsonb_exists(o.data, 'startAfter')
          THEN CASE WHEN right(o.data->>'startAfter', 1) = 'Z'
                 THEN (o.data->>'startAfter')::timestamptz
                 ELSE now() + CAST(o.data->>'startAfter' AS interval) END
          ELSE job.start_after END) + (job.keep_until - job.start_after)
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
        AND job.state < 'active'
      RETURNING job.id, job.start_after
    )
    SELECT id FROM upd
  

=== getQueueStats ===

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
            (count(*) FILTER (WHERE start_after > now() AND state < 'active'))::int as "deferredCount",
            (count(*) FILTER (WHERE state < 'active'))::int as "queuedCount",
            (count(*) FILTER (WHERE state = 'active'))::int as "activeCount",
            (count(*) FILTER (WHERE state = 'failed'))::int as "failedCount",
            count(*)::int as "totalCount",
            array_agg(singleton_key) FILTER (WHERE policy IN ('singleton','stately') AND state = 'active') as "singletonsActive"
          FROM pgboss.job
          WHERE name = ANY($1::text[])
          GROUP BY 1
      ) stats
  
-- values: [["q1","q2"]]

=== cacheQueueStats ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgbossqueue-stats')::bytea), 'hex'))::bit(64)::bigint
  );

    WITH stats AS (
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
            (count(*) FILTER (WHERE start_after > now() AND state < 'active'))::int as "deferredCount",
            (count(*) FILTER (WHERE state < 'active'))::int as "queuedCount",
            (count(*) FILTER (WHERE state = 'active'))::int as "activeCount",
            (count(*) FILTER (WHERE state = 'failed'))::int as "failedCount",
            count(*)::int as "totalCount",
            array_agg(singleton_key) FILTER (WHERE policy IN ('singleton','stately') AND state = 'active') as "singletonsActive"
          FROM pgboss.job
          WHERE name = ANY(ARRAY['q1','q2']::text[])
          GROUP BY 1
      ) stats
  )
    UPDATE pgboss.queue SET
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
          LIMIT 60
        ) capped
      )
    FROM (
      SELECT q.name
      FROM unnest(ARRAY['q1','q2']::text[]) AS q(name)
    ) q
    LEFT JOIN stats ON stats.name = q.name
    WHERE queue.name = q.name
    RETURNING
      queue.name,
      queue.queued_count as "queuedCount",
      queue.warning_queued as "warningQueueSize"
  ;
    COMMIT;
  

=== cacheQueueStats noAdvisoryLocks ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    
    WITH stats AS (
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
            (count(*) FILTER (WHERE start_after > now() AND state < 'active'))::int as "deferredCount",
            (count(*) FILTER (WHERE state < 'active'))::int as "queuedCount",
            (count(*) FILTER (WHERE state = 'active'))::int as "activeCount",
            (count(*) FILTER (WHERE state = 'failed'))::int as "failedCount",
            count(*)::int as "totalCount",
            array_agg(singleton_key) FILTER (WHERE policy IN ('singleton','stately') AND state = 'active') as "singletonsActive"
          FROM pgboss.job
          WHERE name = ANY(ARRAY['q1','q2']::text[])
          GROUP BY 1
      ) stats
  )
    UPDATE pgboss.queue SET
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
          LIMIT 60
        ) capped
      )
    FROM (
      SELECT q.name
      FROM unnest(ARRAY['q1','q2']::text[]) AS q(name)
    ) q
    LEFT JOIN stats ON stats.name = q.name
    WHERE queue.name = q.name
    RETURNING
      queue.name,
      queue.queued_count as "queuedCount",
      queue.warning_queued as "warningQueueSize"
  ;
    COMMIT;
  

=== refreshQueueStats ===

    WITH stats AS (
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
            (count(*) FILTER (WHERE start_after > now() AND state < 'active'))::int as "deferredCount",
            (count(*) FILTER (WHERE state < 'active'))::int as "queuedCount",
            (count(*) FILTER (WHERE state = 'active'))::int as "activeCount",
            (count(*) FILTER (WHERE state = 'failed'))::int as "failedCount",
            count(*)::int as "totalCount",
            array_agg(singleton_key) FILTER (WHERE policy IN ('singleton','stately') AND state = 'active') as "singletonsActive"
          FROM pgboss.job
          WHERE name = ANY(ARRAY['q1']::text[])
          GROUP BY 1
      ) stats
  )
    UPDATE pgboss.queue SET
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
      FROM unnest(ARRAY['q1']::text[]) AS q(name)
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
  

=== serializeArrayParam ===
ARRAY['a','b''c']::text[]

=== serializeJsonParam ===
'{"a":1,"b":"x''y"}'

=== transaction single ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT 1;
    COMMIT;
  

=== transaction multiple ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT 1;
SELECT 2;
    COMMIT;
  

=== locked ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgboss')::bytea), 'hex'))::bit(64)::bigint
  );
SELECT 1;
    COMMIT;
  

=== locked with key ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgbosskey')::bytea), 'hex'))::bit(64)::bigint
  );
SELECT 1;
SELECT 2;
    COMMIT;
  

=== locked noAdvisoryLocks ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT 1;
    COMMIT;
  

=== assertMigration ===
SELECT version::int/(version::int-37) from pgboss.version

=== findJobs base ===

    SELECT id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier",
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

    FROM pgboss.job
    WHERE name = $1
      
    

=== findJobs queued ===

    SELECT id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier",
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

    FROM pgboss.job
    WHERE name = $1
      AND state < 'active'
    

=== findJobs byKey ===

    SELECT id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier",
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

    FROM pgboss.job
    WHERE name = $1
      AND singleton_key = $2
    

=== findJobs byData ===

    SELECT id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier",
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

    FROM pgboss.job
    WHERE name = $1
      AND data @> $2
    

=== findJobs byId ===

    SELECT id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier",
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

    FROM pgboss.job
    WHERE name = $1
      AND id = $2
    

=== findJobs queued byKey byData ===

    SELECT id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier",
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

    FROM pgboss.job
    WHERE name = $1
      AND singleton_key = $2
      AND data @> $3
      AND state < 'active'
    

=== getJobById ===

    SELECT id, name, data, expire_seconds as "expireInSeconds", heartbeat_seconds as "heartbeatSeconds", group_id as "groupId", group_tier as "groupTier",
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

    FROM pgboss.job
    WHERE name = $1
      AND id = $2
    

=== insertDependencies ===

    INSERT INTO pgboss.job_dependency (child_name, child_id, parent_name, parent_id)
    SELECT child_name, child_id, parent_name, parent_id
    FROM json_to_recordset($1::json) AS x (
      child_name text,
      child_id uuid,
      parent_name text,
      parent_id uuid
    )
    ON CONFLICT DO NOTHING
  

=== insertDependencies inline ===

    INSERT INTO pgboss.job_dependency (child_name, child_id, parent_name, parent_id)
    SELECT child_name, child_id, parent_name, parent_id
    FROM json_to_recordset('[{"child_name":"c","child_id":"1","parent_name":"p","parent_id":"2"}]'::json) AS x (
      child_name text,
      child_id uuid,
      parent_name text,
      parent_id uuid
    )
    ON CONFLICT DO NOTHING
  

=== getDependencies ===

    SELECT parent_name as "parentName", parent_id as "parentId"
    FROM pgboss.job_dependency
    WHERE child_name = $1 AND child_id = $2
  

=== getDependents ===

    SELECT child_name as "childName", child_id as "childId"
    FROM pgboss.job_dependency
    WHERE parent_name = $1 AND parent_id = $2
  

=== cleanupDependencies ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.pgbossjobcleanupDependencies')::bytea), 'hex'))::bit(64)::bigint
  );

    DELETE FROM pgboss.job_dependency
    WHERE (child_name = ANY(ARRAY['q1','q2']::text[])
      AND NOT EXISTS (
        SELECT 1 FROM pgboss.job j
        WHERE j.name = child_name AND j.id = child_id
      ))
    OR (parent_name = ANY(ARRAY['q1','q2']::text[])
      AND NOT EXISTS (
        SELECT 1 FROM pgboss.job j
        WHERE j.name = parent_name AND j.id = parent_id
      ))
  ;
    COMMIT;
  

=== cleanupDependencies noAdvisoryLocks ===

    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    
    DELETE FROM pgboss.job_dependency
    WHERE (child_name = ANY(ARRAY['q1','q2']::text[])
      AND NOT EXISTS (
        SELECT 1 FROM pgboss.job j
        WHERE j.name = child_name AND j.id = child_id
      ))
    OR (parent_name = ANY(ARRAY['q1','q2']::text[])
      AND NOT EXISTS (
        SELECT 1 FROM pgboss.job j
        WHERE j.name = parent_name AND j.id = parent_id
      ))
  ;
    COMMIT;
  

=== getBlockedKeys ===

    SELECT DISTINCT singleton_key as "singletonKey"
    FROM pgboss.job
    WHERE name = $1
      AND state = 'failed'
      AND policy = 'key_strict_fifo'
    

=== getNextBamCommand ===

      UPDATE pgboss.bam
      SET status = 'in_progress', started_on = now()
      WHERE id = (
        SELECT id FROM pgboss.bam
        WHERE (
          status IN ('pending', 'failed')
          OR (status = 'in_progress' AND started_on < now() - interval '86400 seconds')
        )
        AND NOT EXISTS (
          SELECT 1 FROM pgboss.bam
          WHERE status = 'in_progress' AND started_on >= now() - interval '86400 seconds'
        )
        ORDER BY (status != 'pending'), created_on
        LIMIT 1
      )
      RETURNING id, name, version, status, queue, table_name as "table", command, error,
                created_on as "createdOn", started_on as "startedOn", completed_on as "completedOn"
    

=== getNextBamCommand liveness ===

    WITH candidate AS (
      SELECT c.id, c.status AS prior_status
      FROM pgboss.bam c
      WHERE (
        c.status IN ('pending', 'failed')
        OR (c.status = 'in_progress' AND (
    c.started_on < now() - interval '300 seconds'
    AND NOT EXISTS (
    SELECT 1 FROM pg_locks l
    WHERE l.locktype = 'relation'
      AND l.granted
      AND l.mode = 'ShareUpdateExclusiveLock'
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.relation = to_regclass(quote_ident('pgboss') || '.' || quote_ident(c.table_name))
  )
  ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM pgboss.bam g
        WHERE g.status = 'in_progress' AND NOT (
    g.started_on < now() - interval '300 seconds'
    AND NOT EXISTS (
    SELECT 1 FROM pg_locks l
    WHERE l.locktype = 'relation'
      AND l.granted
      AND l.mode = 'ShareUpdateExclusiveLock'
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.relation = to_regclass(quote_ident('pgboss') || '.' || quote_ident(g.table_name))
  )
  )
      )
      ORDER BY (c.status != 'pending'), c.created_on
      LIMIT 1
      -- Defense-in-depth against a double-claim. The upstream trySetBamTime throttle serializes healers
      -- to one per interval, but a build running longer than bamIntervalSeconds lets a second instance
      -- pass the throttle while the first is still working. FOR UPDATE SKIP LOCKED makes the claim itself
      -- mutually exclusive: whichever instance locks the head row wins; the other skips it (and, with
      -- LIMIT 1, claims nothing) rather than re-running the same UPDATE and re-driving the command with a
      -- stale prior_status. OF c scopes the lock to the candidate row only, so the NOT EXISTS probe over
      -- bam g is never itself locked. Postgres-only path — SKIP LOCKED is deliberately absent from the
      -- timeout-only variant, which also serves CockroachDB/YugabyteDB where it performs poorly and can
      -- skip unexpectedly.
      FOR UPDATE OF c SKIP LOCKED
    )
    UPDATE pgboss.bam b
    SET status = 'in_progress', started_on = now()
    FROM candidate
    WHERE b.id = candidate.id
    RETURNING b.id, b.name, b.version, b.status, b.queue, b.table_name as "table", b.command, b.error,
              b.created_on as "createdOn", b.started_on as "startedOn", b.completed_on as "completedOn",
              -- reattempt: was this command already tried once (stale-reclaimed in_progress OR a prior
              -- 'failed')? Either way an interrupted/failed CREATE INDEX CONCURRENTLY may have left an
              -- INVALID index, so the runner heals (drop-then-rebuild) before re-running. Fresh
              -- 'pending' rows have nothing to heal.
              (candidate.prior_status <> 'pending') as reattempt
  

=== bamHealDrop ===
DROP INDEX CONCURRENTLY IF EXISTS pgboss.job_i5

=== bamHealProbe ===

    SELECT NOT i.indisvalid AS invalid
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pgboss' AND c.relname = 'job_i5'
  

=== setBamCompleted ===

    UPDATE pgboss.bam
    SET status = 'completed', completed_on = now()
    WHERE id = 'id1'
  

=== setBamFailed ===

    UPDATE pgboss.bam
    SET status = 'failed', error = 'boom', completed_on = now()
    WHERE id = 'id1'
  

=== getBamStatus ===

    SELECT status, count(*)::int as count, max(created_on) as "lastCreatedOn"
    FROM pgboss.bam
    GROUP BY status
  

=== getBamEntries ===

    SELECT id, name, version, status, queue, table_name as "table", command, error,
           created_on as "createdOn", started_on as "startedOn", completed_on as "completedOn"
    FROM pgboss.bam
    ORDER BY version, created_on
  

=== jobCommonExists ===
SELECT to_regclass('pgboss.job_common') as name

=== getManagedQueuePartitions ===
SELECT table_name as "table", policy FROM pgboss.queue WHERE partition = true

=== getIncompleteBamCommands ===
SELECT command FROM pgboss.bam WHERE status <> 'completed'

=== bamCommandIndexName ===
job_i5

=== EXPECTED_JOB_STATES ===
[
  "created",
  "retry",
  "active",
  "completed",
  "cancelled",
  "failed"
]

=== expectedManagedTables partitioned ===
[
  "bam",
  "job",
  "job_common",
  "job_dependency",
  "queue",
  "queue_stats",
  "schedule",
  "subscription",
  "version",
  "warning",
  "j_q1"
]

=== expectedManagedTables nonPartitioned ===
[
  "bam",
  "job",
  "job_dependency",
  "queue",
  "queue_stats",
  "schedule",
  "subscription",
  "version",
  "warning"
]

=== expectedManagedColumns partitioned ===
[
  {
    "table": "bam",
    "columns": [
      "command",
      "completed_on",
      "created_on",
      "error",
      "id",
      "name",
      "queue",
      "started_on",
      "status",
      "table_name",
      "version"
    ],
    "defaults": {
      "created_on": "clock_timestamp()",
      "id": "gen_random_uuid()",
      "status": "'pending'::text"
    },
    "types": {
      "command": {
        "type": "text",
        "notNull": true
      },
      "completed_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "created_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "error": {
        "type": "text",
        "notNull": false
      },
      "id": {
        "type": "uuid",
        "notNull": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "queue": {
        "type": "text",
        "notNull": false
      },
      "started_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "status": {
        "type": "text",
        "notNull": true
      },
      "table_name": {
        "type": "text",
        "notNull": true
      },
      "version": {
        "type": "integer",
        "notNull": true
      }
    }
  },
  {
    "table": "job_dependency",
    "columns": [
      "child_id",
      "child_name",
      "parent_id",
      "parent_name"
    ],
    "defaults": {},
    "types": {
      "child_id": {
        "type": "uuid",
        "notNull": true
      },
      "child_name": {
        "type": "text",
        "notNull": true
      },
      "parent_id": {
        "type": "uuid",
        "notNull": true
      },
      "parent_name": {
        "type": "text",
        "notNull": true
      }
    }
  },
  {
    "table": "queue_stats",
    "columns": [
      "active_count",
      "captured_on",
      "deferred_count",
      "failed_count",
      "id",
      "name",
      "queued_count",
      "ready_count",
      "total_count"
    ],
    "defaults": {
      "active_count": "0",
      "captured_on": "now()",
      "deferred_count": "0",
      "failed_count": "0",
      "id": "gen_random_uuid()",
      "queued_count": "0",
      "ready_count": "0",
      "total_count": "0"
    },
    "types": {
      "active_count": {
        "type": "integer",
        "notNull": true
      },
      "captured_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "deferred_count": {
        "type": "integer",
        "notNull": true
      },
      "failed_count": {
        "type": "integer",
        "notNull": true
      },
      "id": {
        "type": "uuid",
        "notNull": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "queued_count": {
        "type": "integer",
        "notNull": true
      },
      "ready_count": {
        "type": "integer",
        "notNull": true
      },
      "total_count": {
        "type": "integer",
        "notNull": true
      }
    }
  },
  {
    "table": "queue",
    "columns": [
      "active_count",
      "created_on",
      "dead_letter",
      "deferred_count",
      "deletion_seconds",
      "expire_seconds",
      "failed_count",
      "heartbeat_seconds",
      "maintain_on",
      "monitor_on",
      "name",
      "notify",
      "partition",
      "policy",
      "queued_count",
      "ready_count",
      "ready_history",
      "retention_seconds",
      "retry_backoff",
      "retry_delay",
      "retry_delay_max",
      "retry_limit",
      "singletons_active",
      "table_name",
      "total_count",
      "updated_on",
      "warning_queued"
    ],
    "defaults": {
      "active_count": "0",
      "created_on": "now()",
      "deferred_count": "0",
      "failed_count": "0",
      "notify": "false",
      "queued_count": "0",
      "ready_count": "0",
      "ready_history": "'{}'::integer[]",
      "total_count": "0",
      "updated_on": "now()",
      "warning_queued": "0"
    },
    "types": {
      "active_count": {
        "type": "integer",
        "notNull": true
      },
      "created_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "dead_letter": {
        "type": "text",
        "notNull": false
      },
      "deferred_count": {
        "type": "integer",
        "notNull": true
      },
      "deletion_seconds": {
        "type": "integer",
        "notNull": true
      },
      "expire_seconds": {
        "type": "integer",
        "notNull": true
      },
      "failed_count": {
        "type": "integer",
        "notNull": true
      },
      "heartbeat_seconds": {
        "type": "integer",
        "notNull": false
      },
      "maintain_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "monitor_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "notify": {
        "type": "boolean",
        "notNull": true
      },
      "partition": {
        "type": "boolean",
        "notNull": true
      },
      "policy": {
        "type": "text",
        "notNull": true
      },
      "queued_count": {
        "type": "integer",
        "notNull": true
      },
      "ready_count": {
        "type": "integer",
        "notNull": true
      },
      "ready_history": {
        "type": "integer[]",
        "notNull": true
      },
      "retention_seconds": {
        "type": "integer",
        "notNull": true
      },
      "retry_backoff": {
        "type": "boolean",
        "notNull": true
      },
      "retry_delay": {
        "type": "integer",
        "notNull": true
      },
      "retry_delay_max": {
        "type": "integer",
        "notNull": false
      },
      "retry_limit": {
        "type": "integer",
        "notNull": true
      },
      "singletons_active": {
        "type": "text[]",
        "notNull": false
      },
      "table_name": {
        "type": "text",
        "notNull": true
      },
      "total_count": {
        "type": "integer",
        "notNull": true
      },
      "updated_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "warning_queued": {
        "type": "integer",
        "notNull": true
      }
    }
  },
  {
    "table": "schedule",
    "columns": [
      "created_on",
      "cron",
      "data",
      "key",
      "name",
      "options",
      "timezone",
      "updated_on"
    ],
    "defaults": {
      "created_on": "now()",
      "key": "''::text",
      "updated_on": "now()"
    },
    "types": {
      "created_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "cron": {
        "type": "text",
        "notNull": true
      },
      "data": {
        "type": "jsonb",
        "notNull": false
      },
      "key": {
        "type": "text",
        "notNull": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "options": {
        "type": "jsonb",
        "notNull": false
      },
      "timezone": {
        "type": "text",
        "notNull": false
      },
      "updated_on": {
        "type": "timestamp with time zone",
        "notNull": true
      }
    }
  },
  {
    "table": "subscription",
    "columns": [
      "created_on",
      "event",
      "name",
      "updated_on"
    ],
    "defaults": {
      "created_on": "now()",
      "updated_on": "now()"
    },
    "types": {
      "created_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "event": {
        "type": "text",
        "notNull": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "updated_on": {
        "type": "timestamp with time zone",
        "notNull": true
      }
    }
  },
  {
    "table": "version",
    "columns": [
      "bam_on",
      "cron_on",
      "flow_on",
      "version"
    ],
    "defaults": {},
    "types": {
      "bam_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "cron_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "flow_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "version": {
        "type": "integer",
        "notNull": true
      }
    }
  },
  {
    "table": "warning",
    "columns": [
      "created_on",
      "data",
      "id",
      "message",
      "type"
    ],
    "defaults": {
      "created_on": "now()",
      "id": "gen_random_uuid()"
    },
    "types": {
      "created_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "data": {
        "type": "jsonb",
        "notNull": false
      },
      "id": {
        "type": "uuid",
        "notNull": true
      },
      "message": {
        "type": "text",
        "notNull": true
      },
      "type": {
        "type": "text",
        "notNull": true
      }
    }
  },
  {
    "table": "job",
    "columns": [
      "blocked",
      "blocking",
      "completed_on",
      "created_on",
      "data",
      "dead_letter",
      "deletion_seconds",
      "expire_seconds",
      "group_id",
      "group_tier",
      "heartbeat_on",
      "heartbeat_seconds",
      "id",
      "keep_until",
      "name",
      "output",
      "pending_dependencies",
      "policy",
      "priority",
      "retry_backoff",
      "retry_count",
      "retry_delay",
      "retry_delay_max",
      "retry_limit",
      "singleton_key",
      "singleton_on",
      "source_created_on",
      "source_id",
      "source_name",
      "source_retry_count",
      "start_after",
      "started_on",
      "state"
    ]
  },
  {
    "table": "job_common",
    "columns": [
      "blocked",
      "blocking",
      "completed_on",
      "created_on",
      "data",
      "dead_letter",
      "deletion_seconds",
      "expire_seconds",
      "group_id",
      "group_tier",
      "heartbeat_on",
      "heartbeat_seconds",
      "id",
      "keep_until",
      "name",
      "output",
      "pending_dependencies",
      "policy",
      "priority",
      "retry_backoff",
      "retry_count",
      "retry_delay",
      "retry_delay_max",
      "retry_limit",
      "singleton_key",
      "singleton_on",
      "source_created_on",
      "source_id",
      "source_name",
      "source_retry_count",
      "start_after",
      "started_on",
      "state"
    ]
  },
  {
    "table": "j_q1",
    "columns": [
      "blocked",
      "blocking",
      "completed_on",
      "created_on",
      "data",
      "dead_letter",
      "deletion_seconds",
      "expire_seconds",
      "group_id",
      "group_tier",
      "heartbeat_on",
      "heartbeat_seconds",
      "id",
      "keep_until",
      "name",
      "output",
      "pending_dependencies",
      "policy",
      "priority",
      "retry_backoff",
      "retry_count",
      "retry_delay",
      "retry_delay_max",
      "retry_limit",
      "singleton_key",
      "singleton_on",
      "source_created_on",
      "source_id",
      "source_name",
      "source_retry_count",
      "start_after",
      "started_on",
      "state"
    ]
  }
]

=== expectedManagedColumns nonPartitioned ===
[
  {
    "table": "bam",
    "columns": [
      "command",
      "completed_on",
      "created_on",
      "error",
      "id",
      "name",
      "queue",
      "started_on",
      "status",
      "table_name",
      "version"
    ],
    "defaults": {
      "created_on": "clock_timestamp()",
      "id": "gen_random_uuid()",
      "status": "'pending'::text"
    },
    "types": {
      "command": {
        "type": "text",
        "notNull": true
      },
      "completed_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "created_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "error": {
        "type": "text",
        "notNull": false
      },
      "id": {
        "type": "uuid",
        "notNull": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "queue": {
        "type": "text",
        "notNull": false
      },
      "started_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "status": {
        "type": "text",
        "notNull": true
      },
      "table_name": {
        "type": "text",
        "notNull": true
      },
      "version": {
        "type": "integer",
        "notNull": true
      }
    }
  },
  {
    "table": "job_dependency",
    "columns": [
      "child_id",
      "child_name",
      "parent_id",
      "parent_name"
    ],
    "defaults": {},
    "types": {
      "child_id": {
        "type": "uuid",
        "notNull": true
      },
      "child_name": {
        "type": "text",
        "notNull": true
      },
      "parent_id": {
        "type": "uuid",
        "notNull": true
      },
      "parent_name": {
        "type": "text",
        "notNull": true
      }
    }
  },
  {
    "table": "queue_stats",
    "columns": [
      "active_count",
      "captured_on",
      "deferred_count",
      "failed_count",
      "id",
      "name",
      "queued_count",
      "ready_count",
      "total_count"
    ],
    "defaults": {
      "active_count": "0",
      "captured_on": "now()",
      "deferred_count": "0",
      "failed_count": "0",
      "id": "gen_random_uuid()",
      "queued_count": "0",
      "ready_count": "0",
      "total_count": "0"
    },
    "types": {
      "active_count": {
        "type": "integer",
        "notNull": true
      },
      "captured_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "deferred_count": {
        "type": "integer",
        "notNull": true
      },
      "failed_count": {
        "type": "integer",
        "notNull": true
      },
      "id": {
        "type": "uuid",
        "notNull": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "queued_count": {
        "type": "integer",
        "notNull": true
      },
      "ready_count": {
        "type": "integer",
        "notNull": true
      },
      "total_count": {
        "type": "integer",
        "notNull": true
      }
    }
  },
  {
    "table": "queue",
    "columns": [
      "active_count",
      "created_on",
      "dead_letter",
      "deferred_count",
      "deletion_seconds",
      "expire_seconds",
      "failed_count",
      "heartbeat_seconds",
      "maintain_on",
      "monitor_on",
      "name",
      "notify",
      "partition",
      "policy",
      "queued_count",
      "ready_count",
      "ready_history",
      "retention_seconds",
      "retry_backoff",
      "retry_delay",
      "retry_delay_max",
      "retry_limit",
      "singletons_active",
      "table_name",
      "total_count",
      "updated_on",
      "warning_queued"
    ],
    "defaults": {
      "active_count": "0",
      "created_on": "now()",
      "deferred_count": "0",
      "failed_count": "0",
      "notify": "false",
      "queued_count": "0",
      "ready_count": "0",
      "ready_history": "'{}'::integer[]",
      "total_count": "0",
      "updated_on": "now()",
      "warning_queued": "0"
    },
    "types": {
      "active_count": {
        "type": "integer",
        "notNull": true
      },
      "created_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "dead_letter": {
        "type": "text",
        "notNull": false
      },
      "deferred_count": {
        "type": "integer",
        "notNull": true
      },
      "deletion_seconds": {
        "type": "integer",
        "notNull": true
      },
      "expire_seconds": {
        "type": "integer",
        "notNull": true
      },
      "failed_count": {
        "type": "integer",
        "notNull": true
      },
      "heartbeat_seconds": {
        "type": "integer",
        "notNull": false
      },
      "maintain_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "monitor_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "notify": {
        "type": "boolean",
        "notNull": true
      },
      "partition": {
        "type": "boolean",
        "notNull": true
      },
      "policy": {
        "type": "text",
        "notNull": true
      },
      "queued_count": {
        "type": "integer",
        "notNull": true
      },
      "ready_count": {
        "type": "integer",
        "notNull": true
      },
      "ready_history": {
        "type": "integer[]",
        "notNull": true
      },
      "retention_seconds": {
        "type": "integer",
        "notNull": true
      },
      "retry_backoff": {
        "type": "boolean",
        "notNull": true
      },
      "retry_delay": {
        "type": "integer",
        "notNull": true
      },
      "retry_delay_max": {
        "type": "integer",
        "notNull": false
      },
      "retry_limit": {
        "type": "integer",
        "notNull": true
      },
      "singletons_active": {
        "type": "text[]",
        "notNull": false
      },
      "table_name": {
        "type": "text",
        "notNull": true
      },
      "total_count": {
        "type": "integer",
        "notNull": true
      },
      "updated_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "warning_queued": {
        "type": "integer",
        "notNull": true
      }
    }
  },
  {
    "table": "schedule",
    "columns": [
      "created_on",
      "cron",
      "data",
      "key",
      "name",
      "options",
      "timezone",
      "updated_on"
    ],
    "defaults": {
      "created_on": "now()",
      "key": "''::text",
      "updated_on": "now()"
    },
    "types": {
      "created_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "cron": {
        "type": "text",
        "notNull": true
      },
      "data": {
        "type": "jsonb",
        "notNull": false
      },
      "key": {
        "type": "text",
        "notNull": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "options": {
        "type": "jsonb",
        "notNull": false
      },
      "timezone": {
        "type": "text",
        "notNull": false
      },
      "updated_on": {
        "type": "timestamp with time zone",
        "notNull": true
      }
    }
  },
  {
    "table": "subscription",
    "columns": [
      "created_on",
      "event",
      "name",
      "updated_on"
    ],
    "defaults": {
      "created_on": "now()",
      "updated_on": "now()"
    },
    "types": {
      "created_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "event": {
        "type": "text",
        "notNull": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "updated_on": {
        "type": "timestamp with time zone",
        "notNull": true
      }
    }
  },
  {
    "table": "version",
    "columns": [
      "bam_on",
      "cron_on",
      "flow_on",
      "version"
    ],
    "defaults": {},
    "types": {
      "bam_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "cron_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "flow_on": {
        "type": "timestamp with time zone",
        "notNull": false
      },
      "version": {
        "type": "integer",
        "notNull": true
      }
    }
  },
  {
    "table": "warning",
    "columns": [
      "created_on",
      "data",
      "id",
      "message",
      "type"
    ],
    "defaults": {
      "created_on": "now()",
      "id": "gen_random_uuid()"
    },
    "types": {
      "created_on": {
        "type": "timestamp with time zone",
        "notNull": true
      },
      "data": {
        "type": "jsonb",
        "notNull": false
      },
      "id": {
        "type": "uuid",
        "notNull": true
      },
      "message": {
        "type": "text",
        "notNull": true
      },
      "type": {
        "type": "text",
        "notNull": true
      }
    }
  },
  {
    "table": "job",
    "columns": [
      "blocked",
      "blocking",
      "completed_on",
      "created_on",
      "data",
      "dead_letter",
      "deletion_seconds",
      "expire_seconds",
      "group_id",
      "group_tier",
      "heartbeat_on",
      "heartbeat_seconds",
      "id",
      "keep_until",
      "name",
      "output",
      "pending_dependencies",
      "policy",
      "priority",
      "retry_backoff",
      "retry_count",
      "retry_delay",
      "retry_delay_max",
      "retry_limit",
      "singleton_key",
      "singleton_on",
      "source_created_on",
      "source_id",
      "source_name",
      "source_retry_count",
      "start_after",
      "started_on",
      "state"
    ]
  }
]

=== expectedManagedConstraints partitioned ===
[
  {
    "table": "bam",
    "constraints": [
      "PRIMARY KEY (id)"
    ]
  },
  {
    "table": "job_dependency",
    "constraints": [
      "PRIMARY KEY (child_name, child_id, parent_name, parent_id)"
    ]
  },
  {
    "table": "queue_stats",
    "constraints": [
      "PRIMARY KEY (id, captured_on)"
    ]
  },
  {
    "table": "queue",
    "constraints": [
      "CHECK ((dead_letter IS DISTINCT FROM name))",
      "FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name)",
      "PRIMARY KEY (name)"
    ]
  },
  {
    "table": "schedule",
    "constraints": [
      "FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE",
      "PRIMARY KEY (name, key)"
    ]
  },
  {
    "table": "subscription",
    "constraints": [
      "FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE",
      "PRIMARY KEY (event, name)"
    ]
  },
  {
    "table": "version",
    "constraints": [
      "PRIMARY KEY (version)"
    ]
  },
  {
    "table": "warning",
    "constraints": [
      "PRIMARY KEY (id)"
    ]
  }
]

=== expectedManagedConstraints nonPartitioned ===
[
  {
    "table": "bam",
    "constraints": [
      "PRIMARY KEY (id)"
    ]
  },
  {
    "table": "job_dependency",
    "constraints": [
      "PRIMARY KEY (child_name, child_id, parent_name, parent_id)"
    ]
  },
  {
    "table": "queue_stats",
    "constraints": [
      "PRIMARY KEY (id)"
    ]
  },
  {
    "table": "queue",
    "constraints": [
      "CHECK ((dead_letter IS DISTINCT FROM name))",
      "FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name)",
      "PRIMARY KEY (name)"
    ]
  },
  {
    "table": "schedule",
    "constraints": [
      "FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE",
      "PRIMARY KEY (name, key)"
    ]
  },
  {
    "table": "subscription",
    "constraints": [
      "FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE",
      "PRIMARY KEY (event, name)"
    ]
  },
  {
    "table": "version",
    "constraints": [
      "PRIMARY KEY (version)"
    ]
  },
  {
    "table": "warning",
    "constraints": [
      "PRIMARY KEY (id)"
    ]
  }
]

=== expectedManagedFunctions partitioned ===
[
  {
    "name": "create_queue",
    "expectedBody": "DECLARE tablename varchar := CASE WHEN options->>'partition' = 'true' THEN 'j' || encode(sha224(queue_name::bytea), 'hex') ELSE 'job_common' END; queue_created_on timestamptz; BEGIN WITH q as ( INSERT INTO pgboss.queue ( name, policy, retry_limit, retry_delay, retry_backoff, retry_delay_max, expire_seconds, retention_seconds, deletion_seconds, warning_queued, dead_letter, partition, table_name, heartbeat_seconds, notify ) VALUES ( queue_name, options->>'policy', COALESCE((options->>'retryLimit')::int, 2), COALESCE((options->>'retryDelay')::int, 0), COALESCE((options->>'retryBackoff')::bool, false), (options->>'retryDelayMax')::int, COALESCE((options->>'expireInSeconds')::int, 900), COALESCE((options->>'retentionSeconds')::int, 1209600), COALESCE((options->>'deleteAfterSeconds')::int, 604800), COALESCE((options->>'warningQueueSize')::int, 0), options->>'deadLetter', COALESCE((options->>'partition')::bool, false), tablename, (options->>'heartbeatSeconds')::int, COALESCE((options->>'notify')::bool, false) ) ON CONFLICT DO NOTHING RETURNING created_on ) SELECT created_on into queue_created_on from q; IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN RETURN; END IF; EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename); EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename); IF options->>'policy' = 'short' THEN EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename); ELSIF options->>'policy' = 'singleton' THEN EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename); ELSIF options->>'policy' = 'stately' THEN EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename); ELSIF options->>'policy' = 'exclusive' THEN EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename); ELSIF options->>'policy' = 'key_strict_fifo' THEN EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename); END IF; EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name); EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name); END;",
    "definition": "CREATE OR REPLACE FUNCTION pgboss.create_queue(queue_name text, options jsonb) RETURNS void LANGUAGE plpgsql AS $function$ DECLARE tablename varchar := CASE WHEN options->>'partition' = 'true' THEN 'j' || encode(sha224(queue_name::bytea), 'hex') ELSE 'job_common' END; queue_created_on timestamptz; BEGIN WITH q as ( INSERT INTO pgboss.queue ( name, policy, retry_limit, retry_delay, retry_backoff, retry_delay_max, expire_seconds, retention_seconds, deletion_seconds, warning_queued, dead_letter, partition, table_name, heartbeat_seconds, notify ) VALUES ( queue_name, options->>'policy', COALESCE((options->>'retryLimit')::int, 2), COALESCE((options->>'retryDelay')::int, 0), COALESCE((options->>'retryBackoff')::bool, false), (options->>'retryDelayMax')::int, COALESCE((options->>'expireInSeconds')::int, 900), COALESCE((options->>'retentionSeconds')::int, 1209600), COALESCE((options->>'deleteAfterSeconds')::int, 604800), COALESCE((options->>'warningQueueSize')::int, 0), options->>'deadLetter', COALESCE((options->>'partition')::bool, false), tablename, (options->>'heartbeatSeconds')::int, COALESCE((options->>'notify')::bool, false) ) ON CONFLICT DO NOTHING RETURNING created_on ) SELECT created_on into queue_created_on from q; IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN RETURN; END IF; EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename); EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename); IF options->>'policy' = 'short' THEN EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename); ELSIF options->>'policy' = 'singleton' THEN EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename); ELSIF options->>'policy' = 'stately' THEN EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename); ELSIF options->>'policy' = 'exclusive' THEN EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename); ELSIF options->>'policy' = 'key_strict_fifo' THEN EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename); EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename); END IF; EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name); EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name); END; $function$"
  },
  {
    "name": "delete_queue",
    "expectedBody": "DECLARE v_table varchar; v_partition bool; BEGIN SELECT table_name, partition FROM pgboss.queue WHERE name = queue_name INTO v_table, v_partition; IF v_partition THEN EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table); ELSE EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name); END IF; DELETE FROM pgboss.queue WHERE name = queue_name; END;",
    "definition": "CREATE OR REPLACE FUNCTION pgboss.delete_queue(queue_name text) RETURNS void LANGUAGE plpgsql AS $function$ DECLARE v_table varchar; v_partition bool; BEGIN SELECT table_name, partition FROM pgboss.queue WHERE name = queue_name INTO v_table, v_partition; IF v_partition THEN EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table); ELSE EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name); END IF; DELETE FROM pgboss.queue WHERE name = queue_name; END; $function$"
  },
  {
    "name": "job_table_format",
    "expectedBody": "SELECT format( regexp_replace( regexp_replace(command, '\\.job\\y', '.%1$I', 'g'), '\\yjob_i(\\d+)', '%1$s_i\\1', 'g' ), table_name );",
    "definition": "CREATE OR REPLACE FUNCTION pgboss.job_table_format(command text, table_name text) RETURNS text LANGUAGE sql IMMUTABLE AS $function$ SELECT format( regexp_replace( regexp_replace(command, '\\.job\\y', '.%1$I', 'g'), '\\yjob_i(\\d+)', '%1$s_i\\1', 'g' ), table_name ); $function$"
  },
  {
    "name": "job_table_run",
    "expectedBody": "DECLARE tbl RECORD; BEGIN IF queue_name IS NOT NULL THEN SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name; END IF; IF tbl_name IS NOT NULL THEN EXECUTE pgboss.job_table_format(command, tbl_name); RETURN; END IF; EXECUTE pgboss.job_table_format(command, 'job_common'); FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true LOOP EXECUTE pgboss.job_table_format(command, tbl.table_name); END LOOP; END;",
    "definition": "CREATE OR REPLACE FUNCTION pgboss.job_table_run(command text, tbl_name text DEFAULT NULL::text, queue_name text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $function$ DECLARE tbl RECORD; BEGIN IF queue_name IS NOT NULL THEN SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name; END IF; IF tbl_name IS NOT NULL THEN EXECUTE pgboss.job_table_format(command, tbl_name); RETURN; END IF; EXECUTE pgboss.job_table_format(command, 'job_common'); FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true LOOP EXECUTE pgboss.job_table_format(command, tbl.table_name); END LOOP; END; $function$"
  },
  {
    "name": "job_table_run_async",
    "expectedBody": "BEGIN IF queue_name IS NOT NULL THEN SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name; END IF; IF tbl_name IS NOT NULL THEN INSERT INTO pgboss.bam (name, version, status, queue, table_name, command) VALUES ( command_name, version, 'pending', queue_name, tbl_name, pgboss.job_table_format(command, tbl_name) ); RETURN; END IF; INSERT INTO pgboss.bam (name, version, status, queue, table_name, command) SELECT command_name, version, 'pending', NULL, 'job_common', pgboss.job_table_format(command, 'job_common') UNION ALL SELECT command_name, version, 'pending', queue.name, queue.table_name, pgboss.job_table_format(command, queue.table_name) FROM pgboss.queue WHERE partition = true; END;",
    "definition": "CREATE OR REPLACE FUNCTION pgboss.job_table_run_async(command_name text, version integer, command text, tbl_name text DEFAULT NULL::text, queue_name text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $function$ BEGIN IF queue_name IS NOT NULL THEN SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name; END IF; IF tbl_name IS NOT NULL THEN INSERT INTO pgboss.bam (name, version, status, queue, table_name, command) VALUES ( command_name, version, 'pending', queue_name, tbl_name, pgboss.job_table_format(command, tbl_name) ); RETURN; END IF; INSERT INTO pgboss.bam (name, version, status, queue, table_name, command) SELECT command_name, version, 'pending', NULL, 'job_common', pgboss.job_table_format(command, 'job_common') UNION ALL SELECT command_name, version, 'pending', queue.name, queue.table_name, pgboss.job_table_format(command, queue.table_name) FROM pgboss.queue WHERE partition = true; END; $function$"
  }
]

=== expectedManagedFunctions nonPartitioned ===
[
  {
    "name": "create_queue",
    "expectedBody": "BEGIN INSERT INTO pgboss.queue ( name, policy, retry_limit, retry_delay, retry_backoff, retry_delay_max, expire_seconds, retention_seconds, deletion_seconds, warning_queued, dead_letter, partition, table_name, heartbeat_seconds ) VALUES ( queue_name, options->>'policy', COALESCE((options->>'retryLimit')::int, 2), COALESCE((options->>'retryDelay')::int, 0), COALESCE((options->>'retryBackoff')::bool, false), (options->>'retryDelayMax')::int, COALESCE((options->>'expireInSeconds')::int, 900), COALESCE((options->>'retentionSeconds')::int, 1209600), COALESCE((options->>'deleteAfterSeconds')::int, 604800), COALESCE((options->>'warningQueueSize')::int, 0), options->>'deadLetter', false, 'job', (options->>'heartbeatSeconds')::int ) ON CONFLICT DO NOTHING; END;",
    "definition": "CREATE OR REPLACE FUNCTION pgboss.create_queue(queue_name text, options jsonb) RETURNS void LANGUAGE plpgsql AS $function$ BEGIN INSERT INTO pgboss.queue ( name, policy, retry_limit, retry_delay, retry_backoff, retry_delay_max, expire_seconds, retention_seconds, deletion_seconds, warning_queued, dead_letter, partition, table_name, heartbeat_seconds ) VALUES ( queue_name, options->>'policy', COALESCE((options->>'retryLimit')::int, 2), COALESCE((options->>'retryDelay')::int, 0), COALESCE((options->>'retryBackoff')::bool, false), (options->>'retryDelayMax')::int, COALESCE((options->>'expireInSeconds')::int, 900), COALESCE((options->>'retentionSeconds')::int, 1209600), COALESCE((options->>'deleteAfterSeconds')::int, 604800), COALESCE((options->>'warningQueueSize')::int, 0), options->>'deadLetter', false, 'job', (options->>'heartbeatSeconds')::int ) ON CONFLICT DO NOTHING; END; $function$"
  },
  {
    "name": "delete_queue",
    "expectedBody": "BEGIN DELETE FROM pgboss.job WHERE name = queue_name; DELETE FROM pgboss.queue WHERE name = queue_name; END;",
    "definition": "CREATE OR REPLACE FUNCTION pgboss.delete_queue(queue_name text) RETURNS void LANGUAGE plpgsql AS $function$ BEGIN DELETE FROM pgboss.job WHERE name = queue_name; DELETE FROM pgboss.queue WHERE name = queue_name; END; $function$"
  }
]

=== expectedManagedIndexes partitioned ===
[
  {
    "name": "job_common_i1",
    "table": "job_common",
    "keys": "name, COALESCE(singleton_key, '')",
    "predicate": "(state = 'created') AND (policy = 'short')",
    "definition": "CREATE UNIQUE INDEX job_common_i1 ON pgboss.job_common (name, COALESCE(singleton_key, '')) WHERE (state = 'created') AND (policy = 'short')"
  },
  {
    "name": "job_common_i2",
    "table": "job_common",
    "keys": "name, COALESCE(singleton_key, '')",
    "predicate": "(state = 'active') AND (policy = 'singleton')",
    "definition": "CREATE UNIQUE INDEX job_common_i2 ON pgboss.job_common (name, COALESCE(singleton_key, '')) WHERE (state = 'active') AND (policy = 'singleton')"
  },
  {
    "name": "job_common_i3",
    "table": "job_common",
    "keys": "name, state, COALESCE(singleton_key, '')",
    "predicate": "(state <= 'active') AND (policy = 'stately')",
    "definition": "CREATE UNIQUE INDEX job_common_i3 ON pgboss.job_common (name, state, COALESCE(singleton_key, '')) WHERE (state <= 'active') AND (policy = 'stately')"
  },
  {
    "name": "job_common_i4",
    "table": "job_common",
    "keys": "name, singleton_on, COALESCE(singleton_key, '')",
    "predicate": "(state <> 'cancelled') AND (singleton_on IS NOT NULL)",
    "definition": "CREATE UNIQUE INDEX job_common_i4 ON pgboss.job_common (name, singleton_on, COALESCE(singleton_key, '')) WHERE (state <> 'cancelled') AND (singleton_on IS NOT NULL)"
  },
  {
    "name": "job_common_i5",
    "table": "job_common",
    "keys": "name, start_after",
    "predicate": "(state < 'active') AND (NOT blocked)",
    "definition": "CREATE INDEX job_common_i5 ON pgboss.job_common (name, start_after) WHERE (state < 'active') AND (NOT blocked)"
  },
  {
    "name": "job_common_i6",
    "table": "job_common",
    "keys": "name, COALESCE(singleton_key, '')",
    "predicate": "(state <= 'active') AND (policy = 'exclusive')",
    "definition": "CREATE UNIQUE INDEX job_common_i6 ON pgboss.job_common (name, COALESCE(singleton_key, '')) WHERE (state <= 'active') AND (policy = 'exclusive')"
  },
  {
    "name": "job_common_i7",
    "table": "job_common",
    "keys": "name, group_id",
    "predicate": "(state = 'active') AND (group_id IS NOT NULL)",
    "definition": "CREATE INDEX job_common_i7 ON pgboss.job_common (name, group_id) WHERE (state = 'active') AND (group_id IS NOT NULL)"
  },
  {
    "name": "job_common_i8",
    "table": "job_common",
    "keys": "name, singleton_key",
    "predicate": "(state = ANY (ARRAY['active', 'retry', 'failed'])) AND (policy = 'key_strict_fifo')",
    "definition": "CREATE UNIQUE INDEX job_common_i8 ON pgboss.job_common (name, singleton_key) WHERE (state = ANY (ARRAY['active', 'retry', 'failed'])) AND (policy = 'key_strict_fifo')"
  },
  {
    "name": "job_common_i9",
    "table": "job_common",
    "keys": "name, id",
    "predicate": "blocking AND (state = 'completed')",
    "definition": "CREATE INDEX job_common_i9 ON pgboss.job_common (name, id) WHERE blocking AND (state = 'completed')"
  },
  {
    "name": "job_dep_parent_idx",
    "table": "job_dependency",
    "keys": "parent_name, parent_id",
    "predicate": "",
    "definition": "CREATE INDEX job_dep_parent_idx ON pgboss.job_dependency (parent_name, parent_id)"
  },
  {
    "name": "queue_stats_i1",
    "table": "queue_stats",
    "keys": "name, captured_on DESC",
    "predicate": "",
    "definition": "CREATE INDEX queue_stats_i1 ON ONLY pgboss.queue_stats (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count)"
  },
  {
    "name": "warning_i1",
    "table": "warning",
    "keys": "created_on DESC",
    "predicate": "",
    "definition": "CREATE INDEX warning_i1 ON pgboss.warning (created_on DESC)"
  },
  {
    "name": "j_q1_i1",
    "table": "j_q1",
    "keys": "name, COALESCE(singleton_key, '')",
    "predicate": "(state = 'created') AND (policy = 'short')",
    "definition": "CREATE UNIQUE INDEX j_q1_i1 ON pgboss.j_q1 (name, COALESCE(singleton_key, '')) WHERE (state = 'created') AND (policy = 'short')"
  },
  {
    "name": "j_q1_i4",
    "table": "j_q1",
    "keys": "name, singleton_on, COALESCE(singleton_key, '')",
    "predicate": "(state <> 'cancelled') AND (singleton_on IS NOT NULL)",
    "definition": "CREATE UNIQUE INDEX j_q1_i4 ON pgboss.j_q1 (name, singleton_on, COALESCE(singleton_key, '')) WHERE (state <> 'cancelled') AND (singleton_on IS NOT NULL)"
  },
  {
    "name": "j_q1_i5",
    "table": "j_q1",
    "keys": "name, start_after",
    "predicate": "(state < 'active') AND (NOT blocked)",
    "definition": "CREATE INDEX j_q1_i5 ON pgboss.j_q1 (name, start_after) WHERE (state < 'active') AND (NOT blocked)"
  },
  {
    "name": "j_q1_i7",
    "table": "j_q1",
    "keys": "name, group_id",
    "predicate": "(state = 'active') AND (group_id IS NOT NULL)",
    "definition": "CREATE INDEX j_q1_i7 ON pgboss.j_q1 (name, group_id) WHERE (state = 'active') AND (group_id IS NOT NULL)"
  },
  {
    "name": "j_q1_i9",
    "table": "j_q1",
    "keys": "name, id",
    "predicate": "blocking AND (state = 'completed')",
    "definition": "CREATE INDEX j_q1_i9 ON pgboss.j_q1 (name, id) WHERE blocking AND (state = 'completed')"
  }
]

=== expectedManagedIndexes nonPartitioned ===
[
  {
    "name": "job_dep_parent_idx",
    "table": "job_dependency",
    "keys": "parent_name, parent_id",
    "predicate": "",
    "definition": "CREATE INDEX job_dep_parent_idx ON pgboss.job_dependency (parent_name, parent_id)"
  },
  {
    "name": "job_i1",
    "table": "job",
    "keys": "name, COALESCE(singleton_key, '')",
    "predicate": "(state = 'created') AND (policy = 'short')",
    "definition": "CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE (state = 'created') AND (policy = 'short')"
  },
  {
    "name": "job_i2",
    "table": "job",
    "keys": "name, COALESCE(singleton_key, '')",
    "predicate": "(state = 'active') AND (policy = 'singleton')",
    "definition": "CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE (state = 'active') AND (policy = 'singleton')"
  },
  {
    "name": "job_i3",
    "table": "job",
    "keys": "name, state, COALESCE(singleton_key, '')",
    "predicate": "(state <= 'active') AND (policy = 'stately')",
    "definition": "CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE (state <= 'active') AND (policy = 'stately')"
  },
  {
    "name": "job_i4",
    "table": "job",
    "keys": "name, singleton_on, COALESCE(singleton_key, '')",
    "predicate": "(state <> 'cancelled') AND (singleton_on IS NOT NULL)",
    "definition": "CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE (state <> 'cancelled') AND (singleton_on IS NOT NULL)"
  },
  {
    "name": "job_i5",
    "table": "job",
    "keys": "name, start_after",
    "predicate": "(state < 'active') AND (NOT blocked)",
    "definition": "CREATE INDEX job_i5 ON pgboss.job (name, start_after) WHERE (state < 'active') AND (NOT blocked)"
  },
  {
    "name": "job_i6",
    "table": "job",
    "keys": "name, COALESCE(singleton_key, '')",
    "predicate": "(state <= 'active') AND (policy = 'exclusive')",
    "definition": "CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE (state <= 'active') AND (policy = 'exclusive')"
  },
  {
    "name": "job_i7",
    "table": "job",
    "keys": "name, group_id",
    "predicate": "(state = 'active') AND (group_id IS NOT NULL)",
    "definition": "CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE (state = 'active') AND (group_id IS NOT NULL)"
  },
  {
    "name": "job_i8",
    "table": "job",
    "keys": "name, singleton_key",
    "predicate": "(state = ANY (ARRAY['active', 'retry', 'failed'])) AND (policy = 'key_strict_fifo')",
    "definition": "CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE (state = ANY (ARRAY['active', 'retry', 'failed'])) AND (policy = 'key_strict_fifo')"
  },
  {
    "name": "job_i9",
    "table": "job",
    "keys": "name, id",
    "predicate": "blocking AND (state = 'completed')",
    "definition": "CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND (state = 'completed')"
  },
  {
    "name": "queue_stats_i1",
    "table": "queue_stats",
    "keys": "name, captured_on DESC",
    "predicate": "",
    "definition": "CREATE INDEX queue_stats_i1 ON pgboss.queue_stats (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count)"
  },
  {
    "name": "warning_i1",
    "table": "warning",
    "keys": "created_on DESC",
    "predicate": "",
    "definition": "CREATE INDEX warning_i1 ON pgboss.warning (created_on DESC)"
  }
]
