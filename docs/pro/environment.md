# Environment variables

| Variable | Default | What |
| - | - | - |
| `DATABASE_URL` | `postgres://localhost/pgboss` | The database pg-boss uses, or several separated by `|`, each optionally named: `Production=postgres://…`. |
| `PGBOSS_SCHEMA` | `pgboss` | The schema pg-boss was installed into. |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `PGBOSS_DASHBOARD_BASE_PATH` | `/` | Serve under a prefix, such as `/pgboss`. Changing it needs no rebuild, because Pro reads it at startup. |
| `PGBOSS_DASHBOARD_SITE_URL` | | The public address, as `https://host[:port]`, for a Console behind a proxy that ends HTTPS. Links in alerts use it with the base path. Without it, alerts carry no link. The API examples on a service account's page fall back to the address the page was opened at. See [reverse proxy](../dashboard.md#reverse-proxy). |
| `PGBOSS_DASHBOARD_QUERY_TIMEOUT` | `60000` | A statement timeout in milliseconds, for the pages' reads and for the connections the alert evaluator and Operations open. |
| `PGBOSS_PRO_DATABASE_URL` | the first database | Where Pro keeps its own tables. |
| `PGBOSS_PRO_SCHEMA` | `pgboss_pro` | The schema for them, 57 characters at most. Pro creates and migrates the schema on startup. The alert evaluator's pg-boss creates `<schema>_queue` beside it. Pro refuses to start when either schema is a configured database's pg-boss schema in the same database. |
| `PGBOSS_PRO_SECRET_KEY` | | Encrypts stored secrets: email passwords and keys, webhook URLs, secrets and Authorization headers, PagerDuty keys, the SSO client secret. See [secrets](./administration.md#secrets). |
| `PGBOSS_PRO_INSTALL_SCHEMA` | `true` | `false` stops Pro from installing pg-boss's schema in a configured database that has none. See [Run](./install.md#run). |
| `PGBOSS_PRO_SETUP_TOKEN` | | The token `/setup` asks for on a new install. Without it, each process makes its own and prints the link to its log. Set it when several instances share a load balancer. |
| `PGBOSS_PRO_TRUSTED_PROXIES` | loopback | The reverse proxies whose `X-Forwarded-For` Pro reads, as addresses and CIDR ranges separated by commas, such as `10.0.0.5, 10.1.0.0/16`. Pro refuses to start with an entry that is neither. See [Address](./audit-log.md#address). |
| `PGBOSS_PRO_BLOCK_PRIVATE_ADDRESSES` | `false` | `true` keeps webhook and SMTP destinations to public addresses. See [Private addresses](./network.md#private-addresses). |
| `PGBOSS_PRO_FRAME_ANCESTORS` | `'self'` | The pages allowed to show the Console in a frame, as a CSP `frame-ancestors` source list, such as `'self' https://admin.example.com`. By default no other origin may frame it. |

`PGBOSS_DASHBOARD_AUTH_USERNAME` and `PGBOSS_DASHBOARD_AUTH_PASSWORD` do nothing in Pro, which has its own accounts. `PGBOSS_DASHBOARD_READ_ONLY` does nothing either, since roles decide who may change jobs. When any of the three is set, Pro logs on startup that the variable is ignored.
