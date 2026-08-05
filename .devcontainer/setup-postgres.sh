#!/usr/bin/env bash
set -euo pipefail

# Start the cluster (init.d works without systemd inside the container).
sudo service postgresql start

# pg_isready needs no auth, so run it directly over TCP without sudo.
until pg_isready -h 127.0.0.1 -p 5432 -q; do sleep 1; done

# Match test/config.json (postgres/postgres) and docker-compose.yaml (max_connections=400),
# and create the pgboss database. Run via `su - postgres` so it works whether or not sudo is
# allowed to run as a non-root user. All idempotent, so it is safe to re-run on every start.
sudo su - postgres -c "psql -v ON_ERROR_STOP=1" <<'SQL'
ALTER USER postgres WITH PASSWORD 'postgres';
ALTER SYSTEM SET max_connections = 400;
SELECT 'CREATE DATABASE pgboss' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pgboss')\gexec
SQL

sudo service postgresql restart
until pg_isready -h 127.0.0.1 -p 5432 -q; do sleep 1; done
