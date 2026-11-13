# Pro API

The Pro API serves pg-boss's own methods over HTTP with [`@pg-boss/proxy`](../proxy.md), at `/pro/api/v1/<schema>` for each schema. Every call needs an [API token](./api-tokens.md). `<schema>` is the schema's id, shown under **Settings › Schemas**. Under a base path, the API is under it too: `/pgboss/pro/api/v1/…`.

```bash
curl -X POST https://console.example.com/pro/api/v1/pgboss/send \
  -H "Authorization: Bearer $PGBOSS_PRO_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name": "email-welcome", "data": {"to": "sam@example.com"}}'
```

Requests and responses use the proxy's format, `{ "ok": true, "result": … }` or `{ "ok": false, "error": { "message": … } }`. See the [proxy's API usage](../proxy.md#api-usage).

## Permissions

Each method needs a capability, which the service account gets from its role on that schema. Pro refuses any method not listed.

| Needs | Methods |
| - | - |
| Any role on the schema | `getQueue`, `getQueues`, `getQueueStats`, `findJobs`, `getSchedule`, `getSchedules`, `getDependencies`, `getDependents`, `getBlockedKeys`, `previewRedrive`, `previewSchedule`, `schemaVersion`, `isInstalled`, `getBamStatus`, `meta` |
| Send (operator, admin) | `send`, `sendAfter`, `sendThrottled`, `sendDebounced`, `insert`, `upsert`, `update`, `flow` |
| Retry (operator, admin) | `retry`, `redrive` |
| Cancel and resume (operator, admin) | `cancel`, `resume` |
| Delete (admin) | `deleteJob` |
| Queues (admin) | `createQueue`, `updateQueue`, `deleteQueue` |
| Schedules (admin) | `schedule`, `unschedule` |
| Refused, in the Pro Console instead | `deleteQueuedJobs`, `deleteStoredJobs`, `deleteAllJobs`. Deleting many jobs at once is an [operation](./operations.md), where a person confirms the count. |
| Refused, for workers | `fetch`, `complete`, `fail`, `touch`. A worker works jobs through pg-boss itself, or through a [`@pg-boss/proxy`](../proxy.md) it runs on its own, which keeps the Pro API off the application's job path. |
| Refused | `publish`, `subscribe`, `unsubscribe`, `supervise`, `getReindexCommands` |

## Status codes

| Status | When |
| - | - |
| `400` | A request the method can't take, such as a `minutes` value the acknowledge call doesn't offer. |
| `401` | No token, or a token that is unknown, expired, revoked, or whose service account is disabled. |
| `403` | The token's role doesn't include the method, or Pro refuses the method. |
| `404` | No schema by that id, a schema the service account has no role on, or an alert that doesn't exist or is on such a schema. |
| `409` | The schema's pg-boss version isn't the version this Pro makes changes on (see [pg-boss versions](./versions.md)), or the alert to acknowledge is closed or already acknowledged. |
| `429` | Only an invalid token, after too many from this address. |
| `503` | Pro couldn't record the call in the audit log, or couldn't start pg-boss for the schema. The call made no change. |

## Audit

The [audit log](./audit-log.md) records each change, never a read, with the method, the queue, the token and the answer. Sending jobs is recorded only when the service account is set to record it.

## Alerts

Beside pg-boss's methods, the Pro API serves Pro's own alerts:

- `GET /pro/api/v1/alerts`: the open alerts on every schema the service account can see, or on one schema with `?schema=<id>`. Each has its id, schema, severity, title, why, when it opened, and who acknowledged it.
- `POST /pro/api/v1/alerts/<id>/acknowledge`: takes the alert off the needs-attention list for every user, as an operator does in the Pro Console. Send `{ "minutes": 60 }`, `240` or `1440` to acknowledge it for that long, or nothing for as long as it stays open. Needs the operator or admin role on the alert's schema.

## Scaling

The Pro API runs in the same process as the Pro Console. Most traffic needs nothing more. For heavy traffic, such as a producer sending at volume, run more replicas of the same container behind the load balancer. An extra replica costs only memory, because the replicas evaluate alerts once between them. A load balancer can send `/pro/api/` to replicas of its own.
