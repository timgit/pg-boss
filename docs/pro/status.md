# Status

`/pro/status` shows how each queue kept up over the last ninety days, a day at a time, in the shape of a public status page. Each queue has a strip of days and its uptime, and a strip across the top covers every queue. Rows stay in name order whatever their state, since a status page is read by position.

![The status page](../images/pro/status.webp){.light-only}
![The status page](../images/pro/status-dark.webp){.dark-only}

## Recording

Pro's alert evaluator runs once a minute. On each pass it judges every queue's [health](./queues.md#health) over the last hour and records it in Pro's own tables, because pg-boss keeps a week of stats and this page shows ninety days. A pass credits the time since the one before, up to 3 minutes, to the state the queue was last seen in, and a new state starts at the pass that first sees it, so every stretch starts and ends on a pass. A queue too quiet or too new to judge isn't recorded for that time.

When more than 3 minutes go by without a pass, as when Pro was stopped, the next pass replays the gap from the stats pg-boss kept, a minute at a time, as the evaluator would have judged it live. Time pg-boss has no stats for stays unrecorded. The first pass against a database replays as far back as those stats go, so history starts with the week pg-boss already holds. Pro deletes history older than ninety days. The page header says when the last pass finished.

## Days

Days are UTC days. A queue's day adds up the time recorded in each state and takes the color of the least healthy state that totals 5 minutes or more, checking stalled, then falling behind, then absorbing a spike. Short stretches count toward the total, so three 2-minute stalls color a day stalled. Recovering never colors a day, a day with nothing recorded is gray, and today's cell shows the day so far.

Each day on the strip across every queue takes the color of the least healthy queue that day, and is gray only when no queue was recorded. Its tooltip counts the queues in each color. Opening a day there narrows the list to the queues that stalled, fell behind or absorbed a spike that day, and **Affected** lists the queues that did on any day shown. On a narrow screen the strips show the last thirty days.

## Day details

A day colored stalled, falling behind or absorbing a spike opens to its 24 hours as a band and the same day as a timeline. Each row of the timeline is a stretch of one state, with the UTC time it started and, unless the queue was keeping up, how long it lasted. A stretch shorter than 5 minutes is folded into the row next to it, which counts the stretches it includes, while the band shows every stretch. Stretches in the state that colored the day are never folded, so three 2-minute stalls on a day colored stalled are three rows. A gap of 5 minutes or more with nothing recorded is a row of its own, and short stretches just before such a gap show only on the band.

Each change to an [alert](./alerts.md) on the queue that day is a row at the time it happened, linked to the alert: when it opened, who acknowledged it, and when and why it closed. Alert rows are never folded. An alert opened on an earlier day and still open at 00:00 has a row at 00:00 with the day it opened. Every alert on the queue appears except a failed operation's. Alerts don't change a day's color or a queue's uptime, which come only from the recorded states, so a green day opens nothing even when an alert changed that day.

## Uptime

A queue's uptime is the share of its recorded time over the days shown that it wasn't stalled or falling behind. Time absorbing a spike or recovering counts as up. Time with no verdict recorded counts neither way, so a queue with nothing recorded has no uptime.
