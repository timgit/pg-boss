# Environment variables

| Variable | Default | What |
| - | - | - |
| `DATABASE_URL` | | Required. The database pg-boss uses, or several separated by `|`, each optionally named: `Production=postgres://…`. |
| `PGBOSS_SCHEMA` | `pgboss` | The schema pg-boss was installed into. |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `PGBOSS_DASHBOARD_BASE_PATH` | `/` | Serve under a prefix, such as `/pgboss`. Read at startup, so changing it needs no rebuild. |
| `PGBOSS_DASHBOARD_SITE_URL` | | The public address, as `https://host[:port]`, for a Console behind a proxy that ends HTTPS. Links in alerts and the API examples use it with the base path, and carry no link without it. See [reverse proxy](../dashboard.md#reverse-proxy). |
| `PGBOSS_DASHBOARD_QUERY_TIMEOUT` | `60000` | A statement timeout in milliseconds, for the pages' reads and for the connections the alert evaluator and Operations open. |
| `PGBOSS_PRO_DATABASE_URL` | the first database | Where Pro keeps its own tables. |
| `PGBOSS_PRO_SCHEMA` | `pgboss_pro` | The schema for them, 57 characters at most. Pro creates and migrates it on startup, and the alert evaluator's pg-boss creates `<schema>_queue` beside it. Pro refuses to start when either one is a configured database's pg-boss schema in the same database. |
| `PGBOSS_PRO_SECRET_KEY` | | Encrypts stored secrets: email passwords and keys, webhook URLs, secrets and Authorization headers, PagerDuty keys, the SSO client secret. See [secrets](./administration.md#secrets). |
| `PGBOSS_PRO_LICENSE` | | The license text. See [the license](./license.md). |
| `PGBOSS_PRO_LICENSE_FILE` | | A `license.json` somewhere other than the package. |

`PGBOSS_DASHBOARD_AUTH_USERNAME` and `PGBOSS_DASHBOARD_AUTH_PASSWORD` do nothing in Pro, which has its own accounts. When they're set, Pro says so on startup.
