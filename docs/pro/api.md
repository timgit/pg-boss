# HTTP API

Pro serves pg-boss's own methods over HTTP, from [`@pg-boss/proxy`](../proxy.md), on each database at `/pro/api/v1/<database>`, behind an [API token](./api-tokens.md). `<database>` is the database's id: its name in `DATABASE_URL`, or `pgboss` for a single unnamed one. Under a base path, the API is under it too: `/pgboss/pro/api/v1/…`.

```bash
curl -X POST https://console.example.com/pro/api/v1/pgboss/send \
  -H "Authorization: Bearer $PGBOSS_PRO_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name": "email-welcome", "data": {"to": "sam@example.com"}}'
```

Requests and responses are the proxy's, `{ "ok": true, "result": … }` or `{ "ok": false, "error": { "message": … } }`: see the [proxy's API usage](../proxy.md#api-usage).

## What a token may call

Each method needs a capability, held through the service account's role on that database. A method not listed is refused.

| Needs | Methods |
| - | - |
| Any role on the database | `getQueue`, `getQueues`, `getQueueStats`, `findJobs`, `getSchedule`, `getSchedules`, `getDependencies`, `getDependents`, `getBlockedKeys`, `previewRedrive`, `previewSchedule`, `schemaVersion`, `isInstalled`, `getBamStatus`, `meta` |
| Send (operator, admin, worker) | `send`, `sendAfter`, `sendThrottled`, `sendDebounced`, `insert`, `upsert`, `update`, `flow` |
| Work (worker) | `fetch`, `complete`, `fail`, `touch` |
| Retry (operator, admin) | `retry`, `redrive` |
| Cancel and resume (operator, admin) | `cancel`, `resume` |
| Delete (admin) | `deleteJob` |
| Queues (admin) | `createQueue`, `updateQueue`, `deleteQueue` |
| Schedules (admin) | `schedule`, `unschedule` |
| Refused, in the console instead | `deleteQueuedJobs`, `deleteStoredJobs`, `deleteAllJobs`. Deleting many jobs at once is an [operation](./operations.md), where a person confirms the count. |
| Refused | `publish`, `subscribe`, `unsubscribe`, `supervise`, `getReindexCommands` |

## Answers

| Status | When |
| - | - |
| `401` | No token, or one that is unknown, expired, revoked, or whose service account is disabled. |
| `403` | The token's role does not include the method, or the method is refused. |
| `404` | No database by that id, or one the service account has no role on. |
| `409` | The database's pg-boss schema is not the one this Pro makes changes on: see [pg-boss versions](./versions.md). |
| `429` | Too many failed tokens from this address. |

## Audit

Changes are recorded in the [audit log](./audit-log.md) with the method, the queue, the token and the answer. Sending, fetching, completing and failing jobs are recorded only when the service account is set to record them. Reads never are.

## Alerts

Beside pg-boss's methods, Pro's own alerts:

- `GET /pro/api/v1/alerts`: the open alerts on every database the service account can see, or on one with `?database=<id>`. Each has its id, database, severity, title, why, when it opened, and who acknowledged it.
- `POST /pro/api/v1/alerts/<id>/acknowledge`: takes the alert off everybody's list, as an operator does in the console. Send `{ "minutes": 60 }`, `240` or `1440` to acknowledge it for that long, or nothing for as long as it stays open. Needs the operator or admin role on the alert's database.

## Scaling

The API runs in the console's own process. Most traffic needs nothing more. For heavy worker traffic, run more replicas of the same container behind the load balancer: alerts are evaluated once between them, so an extra replica costs only memory. A load balancer can send `/pro/api/` to replicas of its own.
