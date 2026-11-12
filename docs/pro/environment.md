# Environment variables

| Variable | Default | What |
| - | - | - |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `PGBOSS_PRO_BASE_PATH` | `/` | Serve under a prefix, such as `/pgboss`. Changing it needs no rebuild, because Pro reads it at startup. |
| `PGBOSS_PRO_SITE_URL` | | The public address, as `https://host[:port]`, for a Pro Console behind a reverse proxy that ends HTTPS. Links in alerts use it with the base path. Without it, alerts carry no link. The Pro API examples on a service account's page fall back to the address the page was opened at. See [reverse proxy](../dashboard.md#reverse-proxy). |
| `PGBOSS_PRO_QUERY_TIMEOUT` | `60000` | A statement timeout in milliseconds, for the pages' reads and for the connections the alert evaluator and Operations open. |
| `PGBOSS_PRO_DB_HOST` | | Required unless `PGBOSS_PRO_DB_CONNECTION_STRING` is set. The host of Pro's own database, where Pro keeps its tables in `public` and its alert evaluator's pg-boss in `pgboss`. See [Database setup](./install.md#database-setup). |
| `PGBOSS_PRO_DB_PORT` | `5432` | The port of Pro's database. |
| `PGBOSS_PRO_DB_DATABASE` | `pgboss_pro` | The name of Pro's database. |
| `PGBOSS_PRO_DB_USER` | `pgboss_pro` | The role Pro connects to its database as, which should own the database. |
| `PGBOSS_PRO_DB_PASSWORD` | | The role's password. |
| `PGBOSS_PRO_DB_SSLMODE` | | The `sslmode` for Pro's database: `disable`, `prefer`, `require`, `verify-ca`, `verify-full` or `no-verify`, read as node-postgres reads it in a connection string. |
| `PGBOSS_PRO_DB_CONNECTION_STRING` | | A connection string for Pro's database, such as `postgres://pgboss_pro:password@host:5432/pgboss_pro?sslmode=require`. It replaces the other `PGBOSS_PRO_DB_` settings. Use it for a host that gives out a connection string, or for SSL options beyond `sslmode`. |
| `PGBOSS_PRO_SECRET_KEY` | | Required. Encrypts stored secrets: each schema's connection, email passwords and keys, webhook URLs, secrets and Authorization headers, PagerDuty keys, the SSO client secret. See [secrets](./administration.md#secrets). |
| `PGBOSS_PRO_SETUP_TOKEN` | | The token `/setup` asks for on a new install, 32 characters at least, such as the output of `openssl rand -base64 32`. Setup refuses every token while a shorter one is set. Without it, each process makes its own and prints the link to its log. Set it when several instances share a load balancer. |
| `PGBOSS_PRO_TRUSTED_PROXIES` | loopback | The reverse proxies whose `X-Forwarded-For` Pro reads, as addresses and CIDR ranges separated by commas, such as `10.0.0.5, 10.1.0.0/16`. Pro refuses to start with an entry that is neither. See [Address](./audit-log.md#address). |
| `PGBOSS_PRO_BLOCK_PRIVATE_ADDRESSES` | `false` | `true` keeps webhook and SMTP destinations to public addresses. See [Private addresses](./network.md#private-addresses). |
| `PGBOSS_PRO_FRAME_ANCESTORS` | `'self'` | The pages allowed to show the Pro Console in a frame, as a CSP `frame-ancestors` source list, such as `'self' https://admin.example.com`. By default no other origin may frame it. |

The dashboard's names for three of these settings work in Pro too, for an install moved from the dashboard: `PGBOSS_DASHBOARD_BASE_PATH`, `PGBOSS_DASHBOARD_SITE_URL` and `PGBOSS_DASHBOARD_QUERY_TIMEOUT`. When both names are set to different values, Pro uses its own and logs a warning.

`PGBOSS_DASHBOARD_AUTH_USERNAME` and `PGBOSS_DASHBOARD_AUTH_PASSWORD` do nothing in Pro, which has its own accounts. `PGBOSS_DASHBOARD_READ_ONLY` does nothing either, since roles decide who may change jobs. When any of the three is set, Pro logs on startup that the variable is ignored.

`DATABASE_URL` and `PGBOSS_SCHEMA` do nothing in Pro either. Pro logs that they're ignored when they're set. A global admin adds the schemas Pro monitors under **Settings › Schemas**. See [Schemas](./schemas.md).
