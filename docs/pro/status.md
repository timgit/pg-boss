# Status

`/pro/status` shows how each queue kept up over the last ninety days, a day at a time, in the shape of a public status page. A day takes the color of the least healthy state the queue held for 5 minutes or more that day: keeping up, absorbing a spike, falling behind or stalled. Rows stay in name order whatever their state, since a status page is read by position.

![The status page](../images/pro/status.webp){.light-only}
![The status page](../images/pro/status-dark.webp){.dark-only}

Opening a day that wasn't green shows its 24 hours as a band and the same day as a timeline. Each row of the timeline is a stretch of one state, with the UTC time it started and, unless the queue was keeping up, how long it lasted. A stretch shorter than 5 minutes is folded into the row next to it, which counts the stretches it includes. A gap of 5 minutes or more with nothing recorded is a row of its own. Between the stretches, the timeline lists each change to an [alert](./alerts.md) on the queue that day, linked to the alert: when it opened, who acknowledged it, and when and why it closed. Every alert on the queue appears there except a failed operation's. On the strip across every queue, opening a day narrows the list to the queues that weren't green that day.

The page reads the verdicts that Pro's alert evaluator records in its own tables on each pass, once a minute, because pg-boss keeps a week of stats and this page shows ninety days. The page header says when the last pass finished. History starts when Pro first runs against a database.

## Uptime

A queue's uptime is the share of its recorded time that it wasn't stalled or falling behind. Time absorbing a spike or recovering counts as up. Time with no verdict recorded counts neither way, so a queue with nothing recorded has no uptime.
