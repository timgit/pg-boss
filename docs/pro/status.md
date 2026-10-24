# Status

`/pro/status` shows how each queue kept up over the last ninety days, a day at a time, in the shape of a public status page. A day takes the color of the least healthy state the queue held for 5 minutes or more that day: keeping up, absorbing a spike, falling behind or stalled. Rows stay in name order whatever their state, since a status page is read by position.

![The status page](../images/pro/status.webp){.light-only}
![The status page](../images/pro/status-dark.webp){.dark-only}

Open a day that wasn't green to see its incidents. An incident is a [health alert](./alerts.md). It runs from when the queue stalled or fell behind until the alert closed, and names the rule that raised it. Two rules alerting on one queue at once make one incident that names both. Each incident shows when it started and ended, how long the queue was stalled or falling behind, its verdicts in between, and who acknowledged it. Trouble on a day that no rule alerted on is not an incident, and the day says why, such as a dip shorter than the rule's hold or a queue no health rule covers. On the strip across every queue, opening a day narrows the list to the queues that weren't green that day.

The page reads the hourly verdicts that Pro's alert evaluator writes to its own tables on each pass, because pg-boss keeps a week of stats and this page shows ninety days. History starts when Pro first runs against a database.
