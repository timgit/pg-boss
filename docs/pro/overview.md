# Overview

Pro's overview is the free dashboard's [overview](../dashboard.md#overview) with more in each of its sections and a column of cards beside them.

A row at the top counts the open alerts nobody has acknowledged, split into critical and watch, and how many more are acknowledged. It links to the [Alerts](./alerts.md) list, and it appears only while an alert is unacknowledged. The free overview's list of recent warnings is left out, because Pro turns pg-boss warnings into alerts through an [alert rule](./alert-rules.md).

The four figures across all queues are the free ones, with a line added under three of them. **Ready** adds the p95 wait over the last hour and the oldest wait among the jobs ready in the last 5 minutes. **Active** adds how many instances are live, and **Failed** adds how many jobs failed in the last hour. The wait and failure lines read the stats pg-boss records with `persistQueueStats`, and the instance count reads the [instance registry](./instances.md).

The free overview lists the five queues holding the most jobs. Pro lists the first five of the queue list sorted by **Needs attention**, so every queue is judged by its [health](./queues.md#health) over the last hour, and the busier queue goes first when two are equal. pg-boss's own queues are left out. The table adds each queue's health, its p95 wait over the last hour and its share of the last 30 days spent keeping up, and drops the status badge. A link beside the title opens the full [queue list](./queues.md#queues).

The column beside them has three cards:

- **Uptime, 30 days** shows the share of recorded time all queues spent keeping up, and a strip of the last 30 UTC days, each colored by the most severe queue that day. A day opens the [Status](./status.md) page for that day.
- **Instances** shows how many instances are live and how many have gone quiet, the hosts they run on and the pg-boss versions they run. More than one version gets a flag. A bar splits the database's connections between pg-boss, other applications and what is free, out of the server's limit.
- **Activity** shows up to three [operations](./operations.md) that are running or finished in the last day, with their progress, and the five newest changes to this database from the [audit log](./audit-log.md).

![The overview](../images/pro/overview.webp){.light-only}
![The overview](../images/pro/overview-dark.webp){.dark-only}
