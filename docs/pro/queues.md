# Overview and queues

Pro shows the free dashboard's overview and queue pages with its own additions beside them.

## Overview

When any alerts need somebody, a line at the top says how many and links to [Alerts](./alerts.md). Below it are the free overview's figures and queues, then the instances running, the last thirty days of status, and recent activity (operations and changes from the [audit log](./audit-log.md)).

![The overview](../images/pro/overview.webp){.light-only}
![The overview](../images/pro/overview-dark.webp){.dark-only}

## Health

Pro judges each queue over the last hour from the stats pg-boss records. It compares the queue's arrivals with what finished, and its backlog with what it usually holds:

| Verdict | Means |
| - | - |
| Keeping up | Finishing what arrives. |
| Recovering | Working off a backlog that is shrinking. |
| Absorbing a spike | More arriving than finishing, for now. An alert rule can treat a spike that lasts as falling behind. |
| Falling behind | More arriving than finishing, and the backlog growing past what is usual. |
| Stalled | Jobs ready and nothing finishing. |

A queue with too little counted in the hour has no verdict. Health needs `persistQueueStats` on the pg-boss instances that run the monitor.

## Queues

The queue list shows each queue's rates, health, time to drain and workers, with the figures across every queue above them. The range runs from an hour to thirty days, as far back as pg-boss keeps stats. **Cards**, **Table** and **Hex** are three views of the same list. Cards and the table show ten queues a page. The Hex view shows up to 500, each a hexagon colored by its health, and its hexagons get smaller as a page holds more. The smallest show the first letter of each part of the name, so `payments-final` reads `pf`. Hover over one for the queue's name, health and counts. Over a range longer than an hour, a hexagon shows the lower of the queue's health now and the lowest health it held for 5 minutes or more in the range. So a longer range never shows a queue as healthier than a shorter one, and the hover says how long the low point lasted. **Size** above the hexagons keeps them larger: **Fit** shrinks them to fit about a screen, **Names** keeps every queue's name, and **Details** adds its ready count. The choice is remembered. **Show** in the toolbar keeps the Hex view to the queues **Not keeping up**, which hides every hexagon colored Keeping up or Not judged. The filter covers every queue, including those past the first 500. **Needs attention** sorts the queues that need somebody first. The list refreshes every 15 seconds while the tab is visible. In the Hex view, a refresh or a change of range recolors each queue where it is. The order changes only when the sort, filter or page does, and a new queue goes at the end.

![The queues page](../images/pro/queues.webp){.light-only}
![The queues page](../images/pro/queues-dark.webp){.dark-only}

![The Hex view, each queue a hexagon colored by its health](../images/pro/queues-hex.webp){.light-only}
![The Hex view, each queue a hexagon colored by its health](../images/pro/queues-hex-dark.webp){.dark-only}

## Queue detail

A queue's page adds its arrival and finishing rates, p95 wait and run times against the previous period, time to drain, and its health with the reasons for it. Its charts share one time axis: throughput, backlog, wait time and run time.

The sidebar lists the live workers on the queue, with each one's busy slots, from the [instance registry](./instances.md). An instance started with `registerInstance: false`, or on a pg-boss version before 12.36, can work the queue without appearing there.

The backlog chart is the Waiting chart from the free [metrics page](../dashboard.md#queue-metrics), with ready, blocked and deferred jobs stacked and active jobs drawn over them. **View metrics** and the page's counts open this chart, and `/queues/:name/metrics` redirects to it. Pro has one backlog chart, so two charts on different ranges can't disagree.

Under the charts, a row of changes marks what users did through the Pro Console (from the audit log) and what the instances working the queue did. An instance mark shows when one started, stopped, went quiet, or started on a new pg-boss version.

![A queue's page](../images/pro/queue.webp){.light-only}
![A queue's page](../images/pro/queue-dark.webp){.dark-only}

If a queue's `deleteAfterSeconds` is shorter than the monitor pass, the queue deletes finished jobs before the monitor counts them. The page warns about this above the charts. Those jobs are never counted, so throughput and wait and run times read low.

Wait and run times need pg-boss 12.36 or later.
