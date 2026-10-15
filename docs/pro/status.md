# Status

`/pro/status` shows how each queue kept up over the last ninety days, a day at a time, in the shape of a public status page. A day takes the color of the least healthy hour the queue had in it: keeping up, absorbing a spike, falling behind or stalled. Rows stay in name order whatever their state, since a status page is read by position.

![The status page](../images/pro/status.webp){.light-only}
![The status page](../images/pro/status-dark.webp){.dark-only}

Opening a day that was not green shows what happened in it. On the strip for every queue, it narrows the list to the queues that made it so.

The verdicts are the hourly ones Pro's alert evaluator writes each pass into its own tables, since pg-boss keeps a week of stats and this page shows ninety days. History starts when Pro first runs against a database.
