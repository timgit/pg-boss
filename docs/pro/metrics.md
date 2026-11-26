# Prometheus metrics

`/metrics` serves Prometheus metrics for the schemas an [API token](./api-tokens.md)'s service account can see. No metric counts the job table. The metrics come only from what pg-boss already records: the counts it caches on each monitor pass, the last hour of its stats, the health Pro judges each queue to have, open alerts, and the instance registry.

Pro's queue health, Status page and alerts don't need `/metrics`. The endpoint is for a team that already
collects metrics with Prometheus, or with another tool that reads the Prometheus format.

| Metric | Labels | What |
| - | - | - |
| `pgboss_schema_up` | `schema` | 1, or 0 when the schema could not be read within 5 seconds. Pro reads the schemas at once, and a slow one leaves the others in the scrape. |
| `pgboss_queue_jobs` | `schema`, `queue`, `state` | Jobs by state: ready, active, deferred, queued, blocked, failed, total. |
| `pgboss_queue_arrived_per_minute` | `schema`, `queue` | Jobs created per minute over the last hour. |
| `pgboss_queue_finished_per_minute` | `schema`, `queue` | Jobs completed or failed per minute over the last hour. |
| `pgboss_queue_wait_seconds` | `schema`, `queue`, `quantile` | Time from ready to started over the last hour, at 0.5, 0.95 and 0.99. |
| `pgboss_queue_run_seconds` | `schema`, `queue`, `quantile` | Time from started to finished over the last hour. |
| `pgboss_queue_health` | `schema`, `queue`, `verdict` | 1 for the queue's verdict: ok, recovering, absorbing, behind or stalled. A queue with no verdict, such as a paused one, has no series. |
| `pgboss_alerts_open` | `schema`, `severity`, `acknowledged` | Open alerts. |
| `pgboss_instance_live` | `schema`, `instance`, `name`, `host` | 1 while an instance is live, 0 once it has gone quiet. |
| `pgboss_instance_pool_connections` | `schema`, `instance`, `name`, `host`, `state` | Its pool at the last heartbeat: total, idle, waiting. |
| `pgboss_instance_cpu_cores` | `schema`, `instance`, `name`, `host` | CPU cores its process used. |
| `pgboss_instance_memory_bytes` | `schema`, `instance`, `name`, `host` | Its process's resident memory. |
| `pgboss_evaluator_pass_age_seconds` | `schema` | Seconds since Pro's alert evaluator last finished a pass over the schema. Missing until the first pass. |

A service account with a role on all schemas also gets [Pro internal queues](./schemas.md#pro-internal-queues).
The schema menu shows them only to a [global admin](./roles.md#global-admin), which a service account
can't be. They come under `schema="pro_queues"`: a pass queue for each schema, the housekeeping
queue and a send queue for each destination. The metrics of a send queue
carry a `destination` label with the destination's name. Pro's queues have no `pgboss_alerts_open`.
A token whose roles each name one schema doesn't get them.

Each Pro instance reads a schema at most once every 30 seconds and answers the scrapes in between from that read. A metric can be up to 30 seconds old. Pro leaves out any figure pg-boss hasn't recorded instead of reporting it as 0. Rates and health need `persistQueueStats`. Wait times, run times and the instance metrics need pg-boss 12.36. The 0.99 quantile appears once the hour holds 100 finished jobs.

## Scrape configuration

Prometheus needs a token from a [service account](./api-tokens.md) with only the viewer role:

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
