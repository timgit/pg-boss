# Destinations

Destinations are in Settings (`/pro/destinations`), shared by the rules of every
database: email, a webhook, or PagerDuty. **Send test** sends a sample alert that
fires and then resolves, so a receiver's handling of both is proven, and every
attempt, tests included, is listed with what the far end said.

![The destinations page](../images/pro/destinations.webp){.light-only}
![The destinations page](../images/pro/destinations-dark.webp){.dark-only}

Every alert is told when it fires and again when it closes, whichever way it
closes: the condition ended, somebody resolved or acknowledged an event, an event
expired, or its rule changed, was turned off or was deleted. A resolve goes only
where the fire went, once.

**Links in alerts.** Set the console's address on the same page, and emails,
webhooks and PagerDuty link each alert to its page. Until it is set, they carry
no link.

## Email

SMTP or Resend, configured on the same page.

## Webhook

A POST of [Prometheus Alertmanager's webhook body](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config),
version 4, one alert per request, so an on-call tool that takes Alertmanager can
receive Pro's alerts with no relay:

```json
{
  "version": "4",
  "groupKey": "<alert id>",
  "status": "firing",
  "receiver": "<destination name>",
  "groupLabels": { "alertname": "Queue stalled or falling behind" },
  "commonLabels": { "...": "the alert's labels" },
  "commonAnnotations": { "...": "the alert's annotations" },
  "externalURL": "https://console.example.com/pgboss",
  "truncatedAlerts": 0,
  "alerts": [{
    "status": "firing",
    "labels": {
      "alertname": "Queue stalled or falling behind",
      "severity": "critical",
      "database": "pgboss",
      "database_name": "Production",
      "queue": "payments",
      "kind": "stalled",
      "rule_id": "…",
      "rule_version": "3",
      "rule_version_id": "…",
      "source": "pgboss-pro"
    },
    "annotations": { "summary": "payments is stalled", "description": "Nothing has finished for 10 minutes." },
    "startsAt": "2026-10-14T21:00:00Z",
    "endsAt": "0001-01-01T00:00:00Z",
    "generatorURL": "https://console.example.com/pgboss/pro/alerts/<alert id>",
    "fingerprint": "<alert id>"
  }],
  "pgboss": { "alertId": "…", "ruleId": "…", "ruleVersion": 3, "...": "the alert's typed data" }
}
```

- `fingerprint` and `groupKey` are the alert's id, the same on every send for one
  alert, which is what a receiver dedupes on. A resolve has `status: "resolved"`
  and the time it closed in `endsAt`; `pgboss.closedReason` says why.
- `summary` is the title the alert opened with, and stays so while the alert's
  title follows what it finds, say from falling behind to stalled; the
  description then starts with the title as it reads now. Receivers that match a
  resolve to its alert by the summary, such as GoAlert, close what they opened.
- `severity` is `critical`, or `warning` for a rule whose severity is watch.
- Labels hold strings only. `pgboss` carries what each kind of alert adds, typed,
  for a receiver written for Pro; a receiver for Alertmanager ignores it.
- **Signing secret**, optional: every request then carries
  `pgboss-signature: t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 of
  `timestamp.body`. Verify it the way you would a Stripe webhook, and reject
  anything whose timestamp is not recent:

  ```js
  import { createHmac, timingSafeEqual } from 'node:crypto'

  function verified (secret, body, header) {
    const { t, v1 } = Object.fromEntries(header.split(',').map((part) => part.split('=')))
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
    const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest()
    const given = Buffer.from(v1, 'hex')
    return expected.length === given.length && timingSafeEqual(expected, given)
  }
  ```

- **Authorization header**, optional: sent as it is, for a receiver that takes a
  token (`Bearer …`). Stored encrypted, like the signing secret, and never shown
  again once saved.

## PagerDuty

Posts to PagerDuty's Events API v2 with the integration key of an Events API v2
integration on the service you want paged. Each alert triggers one incident,
deduplicated by the alert's id, and resolves it when the alert closes. The
incident's summary is the alert's title, its source the database's name, its
severity `critical` or `warning`, and its details the alert's why, rule and data,
with a link to the alert once the console's address is set. The key is stored
encrypted. A key PagerDuty refuses is recorded as a failed delivery.

Secrets need `PGBOSS_PRO_SECRET_KEY`: see [Secrets](./administration.md#secrets).
