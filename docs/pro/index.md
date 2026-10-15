# pg-boss Pro

pg-boss Pro is the [pg-boss dashboard](../dashboard.md) with the parts a team runs pg-boss with: the changes the free dashboard leaves to code, alerts that reach the people on call, accounts and roles, an audit log, and an API for the scripts and workers around it. It is the same application, configured the same way, so moving from `@pg-boss/dashboard` is a change of package name.

![The Pro overview](../images/pro/overview.webp){.light-only}
![The Pro overview](../images/pro/overview-dark.webp){.dark-only}

## What it adds

- **Changes, by role.** Send, retry, cancel, resume and delete jobs, create and delete queues and schedules, and run [Operations](./operations.md) over every job a filter matches, from the console, each checked against the person's role on that database.
- **Alerts.** [Rules](./alert-rules.md) decide what is an alert: a queue stalled or falling behind, nobody working a queue, a threshold on a queue's counts, rates and waits, pg-boss warnings, an operation that failed. They reach email, a webhook in Prometheus Alertmanager's format, or [PagerDuty](./destinations.md#pagerduty), and every one is told when it closes.
- **Health and history.** Each queue's throughput, wait and run times and time to drain, a verdict on whether it is keeping up, [ninety days of status](./status.md), and the [instances](./instances.md) working each queue.
- **People and access.** [Accounts and groups](./accounts.md) with [roles](./roles.md) per database, [single sign-on](./sso.md) with any OpenID Connect provider, and an [audit log](./audit-log.md) of every change.
- **An API.** pg-boss's own methods over HTTP on each database, behind [API tokens](./api-tokens.md), and [Prometheus metrics](./metrics.md).

## Pricing

A subscription, $1,000 a year or $100 a month, for one organization, with no limit on people, installations or databases. Stop paying and keep the version you have: after twelve months paid in total, the versions released before the subscription ended stay yours to install and run. A subscription brings the versions after it, and support. See [the license](./license.md).

<!-- TODO before launch: the checkout link. -->

Pro sends nothing anywhere you have not configured: see [network activity](./network.md).

## Start

1. [Install and run](./install.md) it.
2. Open `/setup` and create the first administrator.
3. Give the default alert rules a [destination](./destinations.md), so they tell somebody.
