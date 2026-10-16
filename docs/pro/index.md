# pg-boss Pro

pg-boss Pro is the [pg-boss dashboard](../dashboard.md) with what a team needs to run pg-boss. It adds the changes the free dashboard leaves to code, alerts that reach the people on call, accounts and roles, an audit log, and an API for the scripts and workers around it. It's the same application, configured the same way, so moving from `@pg-boss/dashboard` is a change of package name.

![The Pro overview](../images/pro/overview.webp){.light-only}
![The Pro overview](../images/pro/overview-dark.webp){.dark-only}

## What it adds

- From the console, you can send, retry, cancel, resume and delete jobs, create and delete queues and schedules, and run [Operations](./operations.md) over every job a filter matches. Pro checks each change against the person's role on that database.
- [Alert rules](./alert-rules.md) decide what is an alert: a queue stalled or falling behind, nobody working a queue, a threshold on a queue's counts, rates and waits, pg-boss warnings, or an operation that failed. Alerts reach email, a webhook in Prometheus Alertmanager's format, or [PagerDuty](./destinations.md#pagerduty), and Pro tells the destination when each alert closes.
- Pro shows each queue's throughput, wait and run times, time to drain, and whether it's keeping up. It also shows [ninety days of status](./status.md) and the [instances](./instances.md) working each queue.
- [Accounts and groups](./accounts.md) get [roles](./roles.md) per database. Pro also has [single sign-on](./sso.md) with any OpenID Connect provider, and an [audit log](./audit-log.md) of every change.
- An API serves pg-boss's own methods over HTTP on each database, behind [API tokens](./api-tokens.md). Pro also serves [Prometheus metrics](./metrics.md).

## Pricing

Pro costs $1,000 a year or $100 a month for one organization, with no limit on people, installations or databases. If you stop paying after twelve months paid in total, the versions released before the subscription ended stay yours to install and run. While it lasts, a subscription gets you every newer version, and support. See [the license](./license.md).

<!-- TODO before launch: the checkout link. -->

Pro sends nothing anywhere you haven't configured. See [network activity](./network.md).

## Start

1. [Install and run](./install.md) it.
2. Open `/setup` and create the first administrator.
3. Give the default alert rules a [destination](./destinations.md), so their alerts reach somebody.
