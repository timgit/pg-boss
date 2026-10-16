# Environment variables

| Variable | Default | What |
| - | - | - |
| `DATABASE_URL` | | Required. The database pg-boss uses, or several separated by `|`, each optionally named: `Production=postgres://…`. |
| `PGBOSS_SCHEMA` | `pgboss` | The schema pg-boss was installed into. |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `PGBOSS_DASHBOARD_BASE_PATH` | `/` | Serve under a prefix, such as `/pgboss`. Read at startup, no rebuild. |
| `PGBOSS_DASHBOARD_QUERY_TIMEOUT` | | A statement timeout for the pages' reads, in milliseconds. |
| `PGBOSS_PRO_DATABASE_URL` | the first database | Where Pro keeps its own tables. |
| `PGBOSS_PRO_SCHEMA` | `pgboss_pro` | The schema for them, created and migrated on startup. |
| `PGBOSS_PRO_SECRET_KEY` | | Encrypts stored secrets: email passwords and keys, webhook URLs, secrets and Authorization headers, PagerDuty keys, the SSO client secret. See [secrets](./administration.md#secrets). |
| `PGBOSS_PRO_LICENSE` | | The license text. See [the license](./license.md). |
| `PGBOSS_PRO_LICENSE_FILE` | | A `license.json` somewhere other than the package. |

`PGBOSS_DASHBOARD_AUTH_USERNAME` and `PGBOSS_DASHBOARD_AUTH_PASSWORD` do nothing in Pro, which has its own accounts, and Pro says so on startup when they are set.
