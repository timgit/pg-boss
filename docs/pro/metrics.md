# Metrics

`/metrics` serves Prometheus metrics for the databases an [API token](./api-tokens.md)'s service account can see. The metrics come from what pg-boss already records: the counts it caches on each monitor pass, the last hour of its stats, the health Pro judges each queue to have, open alerts, and the instance registry. It never counts the job table. Under a base path, the endpoint moves under it too, as in `/pgboss/metrics`.

| Metric | Labels | What |
| - | - | - |
| `pgboss_database_up` | `database` | 1, or 0 when the database could not be read. |
| `pgboss_queue_jobs` | `database`, `queue`, `state` | Jobs by state: ready, active, deferred, queued, blocked, failed, total. |
| `pgboss_queue_arrived_per_minute` | `database`, `queue` | Jobs created per minute over the last hour. |
| `pgboss_queue_finished_per_minute` | `database`, `queue` | Jobs finished per minute over the last hour. |
| `pgboss_queue_wait_seconds` | `database`, `queue`, `quantile` | Time from ready to started over the last hour, at 0.5, 0.95 and 0.99. |
| `pgboss_queue_run_seconds` | `database`, `queue`, `quantile` | Time from started to finished over the last hour. |
| `pgboss_queue_health` | `database`, `queue`, `verdict` | 1 for the queue's verdict: ok, recovering, absorbing, behind or stalled. |
| `pgboss_alerts_open` | `database`, `severity`, `acknowledged` | Open alerts. |
| `pgboss_instance_live` | `database`, `instance`, `name`, `host` | 1 while an instance is live, 0 once it has gone quiet. |
| `pgboss_instance_pool_connections` | `database`, `instance`, `name`, `host`, `state` | Its pool at the last heartbeat: total, idle, waiting. |
| `pgboss_instance_cpu_cores` | `database`, `instance`, `name`, `host` | CPU cores its process used. |
| `pgboss_instance_memory_bytes` | `database`, `instance`, `name`, `host` | Its process's resident memory. |

Pro leaves out any figure pg-boss hasn't recorded, so it never shows up as 0. Rates and health need `persistQueueStats`. Wait times, run times and the instance metrics need pg-boss 12.36. The 0.99 quantile appears once the hour holds 100 finished jobs.

## Prometheus

A viewer's token is enough:

```yaml
scrape_configs:
  - job_name: pgboss
    metrics_path: /metrics
    scheme: https
    authorization:
      credentials_file: /etc/prometheus/pgboss-pro-token
    static_configs:
      - targets: ['console.example.com']
```
