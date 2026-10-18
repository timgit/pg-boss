# pg-boss Pro

Once your business runs on pg-boss, a stalled queue is an outage. Pro alerts whoever is on call, by email, webhook or a paging service. Your team can retry, cancel and delete jobs from the browser, each person signed in with their own role, and the audit log records every change. Pro is built and supported by the author of pg-boss. It's the [free dashboard](../dashboard.md) with all this added, so upgrading from `@pg-boss/dashboard` is a change of package name.

![The Pro overview](../images/pro/overview.webp){.light-only}
![The Pro overview](../images/pro/overview-dark.webp){.dark-only}

## Features

- From the console, you can send, retry, cancel, resume and delete jobs, create and delete queues and schedules, and run [Operations](./operations.md) over every job a filter matches. Pro checks each change against the person's role on that database.
- [Alert rules](./alert-rules.md) decide what is an alert: a queue stalled or falling behind, nobody working a queue, a threshold on a queue's counts, rates and waits, pg-boss warnings, or an operation that failed. Alerts reach email, a webhook in Prometheus Alertmanager's format, or [PagerDuty](./destinations.md#pagerduty), and Pro tells the destination when each alert closes.
- Pro shows each queue's throughput, wait and run times, time to drain, and whether it's keeping up. It also shows [ninety days of status](./status.md) and the [instances](./instances.md) working each queue.
- [Accounts and groups](./accounts.md) get [roles](./roles.md) per database. Pro also has [single sign-on](./sso.md) with any OpenID Connect provider, and an [audit log](./audit-log.md) of every change.
- An API serves pg-boss's own methods over HTTP on each database, behind [API tokens](./api-tokens.md). Pro also serves [Prometheus metrics](./metrics.md).

## Pricing

Pro costs $1,000 a year or $100 a month for one organization, with no limit on people, installations or databases. If you stop paying after twelve months paid in total, the versions released before the subscription ended stay yours to install and run. While it lasts, a subscription gets you every newer version, and support. See [the license](./license.md).

[Buy Pro](https://buy.polar.sh/polar_cl_YGSAhTFmC6APdILc2m8MtIABaLUbAJjSIjooL0pP4lc). Polar takes the payment and shows your license key on your purchases page.

Pro sends nothing anywhere you haven't configured. See [network activity](./network.md).

## Getting started

1. [Install and run](./install.md) it.
2. Open `/setup` and create the first administrator.
3. Give the default alert rules a [destination](./destinations.md), so their alerts reach somebody.
