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
| [`PGBOSS_PRO_FRAME_ANCESTORS`](#pgboss-pro-frame-ancestors) | `'self'` |

## Server

### `PORT`

The port Pro listens on.

Default: `3000`

### `HOST`

The interface Pro listens on.

Default: `0.0.0.0`

### `PGBOSS_PRO_BASE_PATH`

The path prefix Pro serves under, such as `/pgboss`. Changing it needs no rebuild, because Pro reads it at startup.

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

The token `/setup` asks for on a new install. It needs 32 characters or more, such as the output of `openssl rand -base64 32`. Setup refuses every token while a shorter one is set. Without the variable, each process makes its own token and prints the setup link to its log. Set it when several instances share a load balancer.

### `PGBOSS_PRO_TRUSTED_PROXIES`

The reverse proxies whose `X-Forwarded-For` header Pro reads. The value is a comma-separated list of addresses and CIDR ranges, such as `10.0.0.5, 10.1.0.0/16`. Pro refuses to start with an entry that is neither. See [Address](./audit-log.md#address).

Default: loopback

### `PGBOSS_PRO_BLOCK_PRIVATE_ADDRESSES`

`true` keeps webhook and SMTP destinations to public addresses. See [Private addresses](./network.md#private-addresses).

Default: `false`

### `PGBOSS_PRO_FRAME_ANCESTORS`

The pages allowed to show the Pro Console in a frame. The value is a CSP `frame-ancestors` source list, such as `'self' https://admin.example.com`. By default no other origin may frame the Pro Console.

Default: `'self'`

## Dashboard variables

The dashboard's names for three of these settings work in Pro too, for an install moved from the dashboard: `PGBOSS_DASHBOARD_BASE_PATH`, `PGBOSS_DASHBOARD_SITE_URL` and `PGBOSS_DASHBOARD_QUERY_TIMEOUT`. When both names are set to different values, Pro uses its own and logs a warning.

`PGBOSS_DASHBOARD_AUTH_USERNAME` and `PGBOSS_DASHBOARD_AUTH_PASSWORD` do nothing in Pro, which has its own accounts. `PGBOSS_DASHBOARD_READ_ONLY` does nothing either, since roles decide who may change jobs. When any of the three is set, Pro logs on startup that the variable is ignored.

`DATABASE_URL` does nothing in Pro either. Pro logs that the variable is ignored when it's set. A global admin adds the schemas Pro monitors under **Settings › Schemas**. See [Schemas](./schemas.md).
