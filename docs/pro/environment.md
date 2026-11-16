---
outline: 2
---

# Environment variables

Pro reads its settings from the environment, and from a `.env` file in the directory it starts in. A variable set in the environment takes precedence over the same variable in the file.

| Variable | Default |
| - | - |
| [`PORT`](#port) | `3000` |
| [`HOST`](#host) | `0.0.0.0` |
| [`PGBOSS_PRO_BASE_PATH`](#pgboss-pro-base-path) | `/` |
| [`PGBOSS_PRO_SITE_URL`](#pgboss-pro-site-url) | |
| [`PGBOSS_PRO_QUERY_TIMEOUT`](#pgboss-pro-query-timeout) | `60000` |
| [`PGBOSS_PRO_DB_HOST`](#pgboss-pro-db-host) | *Required without a connection string* |
| [`PGBOSS_PRO_DB_PORT`](#pgboss-pro-db-port) | `5432` |
| [`PGBOSS_PRO_DB_DATABASE`](#pgboss-pro-db-database) | `pgboss_pro` |
| [`PGBOSS_PRO_DB_USER`](#pgboss-pro-db-user) | `pgboss_pro` |
| [`PGBOSS_PRO_DB_PASSWORD`](#pgboss-pro-db-password) | |
| [`PGBOSS_PRO_DB_SSLMODE`](#pgboss-pro-db-sslmode) | |
| [`PGBOSS_PRO_DB_CONNECTION_STRING`](#pgboss-pro-db-connection-string) | |
| [`PGBOSS_PRO_SECRET_KEY`](#pgboss-pro-secret-key) | *Required* |
| [`PGBOSS_PRO_SETUP_TOKEN`](#pgboss-pro-setup-token) | |
| [`PGBOSS_PRO_TRUSTED_PROXIES`](#pgboss-pro-trusted-proxies) | loopback |
| [`PGBOSS_PRO_BLOCK_PRIVATE_ADDRESSES`](#pgboss-pro-block-private-addresses) | `false` |
| [`PGBOSS_PRO_LOG_FORMAT`](#pgboss-pro-log-format) | `text` |

## Server

### `PORT`

The port Pro listens on.

Default: `3000`

### `HOST`

The interface Pro listens on.

Default: `0.0.0.0`

### `PGBOSS_PRO_BASE_PATH`

The path prefix Pro serves under, such as `/pgboss`. Set it when a reverse proxy serves Pro under a path of an existing site. Changing it needs no rebuild, because Pro reads it at startup.

Default: `/`

### `PGBOSS_PRO_SITE_URL`

The public address of a Pro Console behind a reverse proxy that ends HTTPS, as `https://host[:port]`. Links in alerts use it with the base path. Without it, alerts carry no link. The Pro API examples on a service account's page fall back to the address the page was opened at. See [reverse proxy](../dashboard.md#reverse-proxy).

### `PGBOSS_PRO_QUERY_TIMEOUT`

A statement timeout in milliseconds for the pages' reads and for the connections the alert evaluator and Operations open.

Default: `60000`

## Database

### `PGBOSS_PRO_DB_HOST`

The host of the database, where Pro keeps its tables in `public` and its alert evaluator's pg-boss in `pgboss`. See [Database setup](./install.md#database-setup).

Required unless `PGBOSS_PRO_DB_CONNECTION_STRING` is set.

### `PGBOSS_PRO_DB_PORT`

The port of the database.

Default: `5432`

### `PGBOSS_PRO_DB_DATABASE`

The name of the database.

Default: `pgboss_pro`

### `PGBOSS_PRO_DB_USER`

The role Pro connects to the database as. The role should own the database.

Default: `pgboss_pro`

### `PGBOSS_PRO_DB_PASSWORD`

The password of the `PGBOSS_PRO_DB_USER` role.

### `PGBOSS_PRO_DB_SSLMODE`

The `sslmode` for the database, read as node-postgres reads it in a connection string. It takes `disable`, `prefer`, `require`, `verify-ca`, `verify-full` or `no-verify`.

### `PGBOSS_PRO_DB_CONNECTION_STRING`

A connection string for the database. It replaces the other `PGBOSS_PRO_DB_` settings. Use it for a host that gives out a connection string, or for SSL options beyond `sslmode`. With SSL required, the variable looks like this:

```bash
PGBOSS_PRO_DB_CONNECTION_STRING=postgres://pgboss_pro:password@host:5432/pgboss_pro?sslmode=require
```

## Security

### `PGBOSS_PRO_SECRET_KEY`

The key Pro encrypts stored secrets with. Pro encrypts each schema's connection, email passwords and keys, webhook URLs, secrets and Authorization headers, PagerDuty keys, and the SSO client secret. See [secrets](./administration.md#secrets).

Required.

### `PGBOSS_PRO_SETUP_TOKEN`

The token `/setup` asks for on a new install. It needs 32 characters or more, such as the output of `openssl rand -base64 32`. Setup refuses every token while a shorter one is set. Without the variable, each process makes its own token and prints the setup link to its log. With it, the log shows the whole link only when it goes to a terminal, and the variable's name in place of the token anywhere else. Set it when several instances share a load balancer.

### `PGBOSS_PRO_TRUSTED_PROXIES`

The reverse proxies whose `X-Forwarded-For` header Pro reads. The value is a comma-separated list of addresses and CIDR ranges, such as `10.0.0.5, 10.1.0.0/16`. Pro refuses to start with an entry that is neither. See [Address](./audit-log.md#address).

Default: loopback

### `PGBOSS_PRO_BLOCK_PRIVATE_ADDRESSES`

`true` keeps webhook and SMTP destinations to public addresses. See [Private addresses](./network.md#private-addresses).

Default: `false`

## Logging

### `PGBOSS_PRO_LOG_FORMAT`

The format of Pro's log. With a value other than `text`, `json` or `pretty`, Pro logs a warning and writes text. [`pg-boss-pro doctor`](./install.md#check-the-install) reports such a value as a failed check.

| Value | Output |
| - | - |
| `text` | One line per message, starting with `pg-boss Pro`. Warnings and errors go to standard error. Other lines go to standard output. |
| `json` | One JSON object per line, on standard output. |
| `pretty` | Each message after its time and level, with its fields on the lines below, on standard output. It's in color when standard output is a terminal. |

With `json` or `pretty`, the lines the dashboard and its libraries print come out in the same format as Pro's. A stack trace that Node prints for a crash stays plain text.

Each JSON object has `level`, `time`, `app` and `msg`. A line about a schema, alert rule or queue names the schema, rule or queue in a field of its own, such as `schema` or `rule`. A line about an error has an `err` field with the error's `type`, `message` and `stack`:

```json
{"level":"error","time":"2026-11-16T16:19:34.306Z","app":"pg-boss Pro","err":{"type":"Error","message":"connect ECONNREFUSED 10.0.0.7:5432","stack":"Error: connect ECONNREFUSED 10.0.0.7:5432\n    at …","code":"ECONNREFUSED"},"schema":"billing","msg":"could not read billing for /metrics"}
```

Default: `text`

## Dashboard variables

The dashboard's names for three of these settings do nothing in Pro: `PGBOSS_DASHBOARD_BASE_PATH`, `PGBOSS_DASHBOARD_SITE_URL` and `PGBOSS_DASHBOARD_QUERY_TIMEOUT`. Set `PGBOSS_PRO_BASE_PATH`, `PGBOSS_PRO_SITE_URL` and `PGBOSS_PRO_QUERY_TIMEOUT` instead.

`PGBOSS_DASHBOARD_AUTH_USERNAME` and `PGBOSS_DASHBOARD_AUTH_PASSWORD` do nothing in Pro, which has its own accounts. `PGBOSS_DASHBOARD_READ_ONLY` does nothing either, since roles decide who may change jobs.

`DATABASE_URL` does nothing in Pro either. Pro logs that the variable is ignored when it's set. A global admin adds the schemas Pro monitors under **Settings › Schemas**. See [Schemas](./schemas.md).
