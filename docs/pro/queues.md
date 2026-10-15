# Overview and queues

Pro draws the free dashboard's overview and queue pages with what it adds beside them.

## Overview

A line at the top says how many alerts need somebody, when any do, and links to [Alerts](./alerts.md). Below it are the free overview's figures and queues, then the instances running, the last thirty days of status, and recent activity: operations and changes from the [audit log](./audit-log.md).

![The overview](../images/pro/overview.webp){.light-only}
![The overview](../images/pro/overview-dark.webp){.dark-only}

## Health

Pro judges each queue over the last hour from the stats pg-boss records, its arrivals against what finished and its backlog against what it usually holds:

| Verdict | Means |
| - | - |
| Keeping up | Finishing what arrives. |
| Recovering | Working off a backlog that is shrinking. |
| Absorbing a spike | More arriving than finishing, for now; an alert rule can treat a spike that lasts as falling behind. |
| Falling behind | More arriving than finishing, and the backlog growing past what is usual. |
| Stalled | Jobs ready and nothing finishing. |

A queue with too little counted in the hour has no verdict. Health needs `persistQueueStats` on the pg-boss instances that run the monitor.

## Queues

The queue list shows each queue's rates over a range, from an hour to thirty days as far as pg-boss keeps stats, with its health, its time to drain and the workers on it, and the figures across every queue above them. Cards, a table and a honeycomb of every queue at once are three views of the same list. **Needs attention** sorts the queues that need somebody first.

![The queues page](../images/pro/queues.webp){.light-only}
![The queues page](../images/pro/queues-dark.webp){.dark-only}

## A queue

A queue's page adds its arrival and finishing rates, p95 wait and run times against the previous period, time to drain, and its health with the reasons for it. Its charts share one time axis: throughput, backlog, wait time and run time. Under them, a row of changes marks what people did through the console, from the audit log, and what the instances working the queue did: started, stopped, went quiet, or started on a new pg-boss version.

![A queue's page](../images/pro/queue.webp){.light-only}
![A queue's page](../images/pro/queue-dark.webp){.dark-only}

When a queue deletes finished jobs sooner than the monitor counts them, its `deleteAfterSeconds` shorter than the monitor pass, the page says so above the charts: those jobs are never counted, so throughput and wait and run times read low.

Wait and run times need pg-boss 12.36 or later.
