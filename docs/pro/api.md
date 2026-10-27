# Pro API

The Pro API serves pg-boss's own methods over HTTP with [`@pg-boss/proxy`](../proxy.md), at `/pro/api/v1/<database>` for each database, and every call needs an [API token](./api-tokens.md). `<database>` is the database's id: its name in `DATABASE_URL`, or `pgboss` for a single unnamed one. Under a base path, the API is under it too: `/pgboss/pro/api/v1/…`.

```bash
curl -X POST https://console.example.com/pro/api/v1/pgboss/send \
  -H "Authorization: Bearer $PGBOSS_PRO_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name": "email-welcome", "data": {"to": "sam@example.com"}}'
```

Requests and responses use the proxy's format, `{ "ok": true, "result": … }` or `{ "ok": false, "error": { "message": … } }`. See the [proxy's API usage](../proxy.md#api-usage).

## Permissions

Each method needs a capability, which the service account gets from its role on that database. Pro refuses any method not listed.

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
| Refused, in the Pro Console instead | `deleteQueuedJobs`, `deleteStoredJobs`, `deleteAllJobs`. Deleting many jobs at once is an [operation](./operations.md), where a person confirms the count. |
| Refused | `publish`, `subscribe`, `unsubscribe`, `supervise`, `getReindexCommands` |

## Status codes

| Status | When |
| - | - |
| `401` | No token, or one that is unknown, expired, revoked, or whose service account is disabled. |
| `403` | The token's role doesn't include the method, or Pro refuses the method. |
| `404` | No database by that id, or one the service account has no role on. |
| `409` | The database's pg-boss schema isn't the one this Pro makes changes on. See [pg-boss versions](./versions.md). |
| `429` | Too many failed tokens from this address. |

## Audit

The [audit log](./audit-log.md) records each change with the method, the queue, the token and the answer. Sending, fetching, completing and failing jobs are recorded only when the service account is set to record them. Reads never are.

## Alerts

Beside pg-boss's methods, the API serves Pro's own alerts:

- `GET /pro/api/v1/alerts`: the open alerts on every database the service account can see, or on one with `?database=<id>`. Each has its id, database, severity, title, why, when it opened, and who acknowledged it.
- `POST /pro/api/v1/alerts/<id>/acknowledge`: takes the alert off the needs-attention list for every user, as an operator does in the Console. Send `{ "minutes": 60 }`, `240` or `1440` to acknowledge it for that long, or nothing for as long as it stays open. Needs the operator or admin role on the alert's database.

## Scaling

The API runs in the same process as the Console. Most traffic needs nothing more. For heavy worker traffic, run more replicas of the same container behind the load balancer. The replicas evaluate alerts once between them, so an extra replica costs only memory. A load balancer can send `/pro/api/` to replicas of its own.
