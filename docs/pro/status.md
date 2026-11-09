# Status

The **Status** page is laid out like a public status page and shows how each queue kept up on each of the last ninety days. Each queue has a strip of days and its uptime. A strip at the top of the page summarizes status across all queues.

![The status page](../images/pro/status.webp){.light-only}
![The status page](../images/pro/status-dark.webp){.dark-only}

## Recording

Pro's alert evaluator runs a pass once a minute. Each pass adds the time since the previous run to the verdict the queue was last given. A queue too quiet or too new to judge isn't recorded for that time.

When more than 3 minutes go by without a pass, as when Pro was stopped, the next pass replays the gap a minute at a time from the stats pg-boss kept. Each minute is judged as the evaluator would have judged it live. Time pg-boss has no stats for stays unrecorded. The first pass against a database replays as far back as those stats go. History starts with the stats pg-boss already holds (a week by default). Pro deletes history older than ninety days. The page header says when the last pass finished.

## Days

Days are UTC days. Today's cell shows the day so far. A queue's day adds up the time recorded in each verdict and takes the color of the least healthy [verdict](./queues.md#health) that totals 5 minutes or more. The table lists the verdicts from least healthy. Three 2-minute stalls color a day stalled, because short stretches count toward the total.

| Color | Verdict |
| - | - |
| Red | Stalled |
| Orange | Falling behind |
| Yellow | Absorbing a spike |
| Green | Keeping up. No verdict above reached 5 minutes. A day spent recovering is green too, because recovering doesn't color a day. |
| Gray | Nothing recorded for the queue that day |

Each day on the summary strip takes the color of the least healthy queue that recorded anything that day. A day colored stalled, falling behind, or absorbing a spike is clickable. Clicking a day filters the list below to the affected queues.

## Day details

Clicking a day on a queue's strip opens a drawer with its 24 hours as a band and the same day as a timeline. The band colors each stretch as the table above does, and shows recovering stretches in blue. Each row of the timeline is a stretch of one verdict with the UTC time it started. A stretch shorter than 5 minutes is folded into the row next to it, which counts the stretches it includes. Stretches in the verdict that colored the day aren't folded. On a day colored stalled, three 2-minute stalls are three rows. A gap of 5 minutes or more with nothing recorded is a row of its own. Short stretches just before such a gap show only on the band.

![A day's details on the status page](../images/pro/status-day.webp){.light-only}
![A day's details on the status page](../images/pro/status-day-dark.webp){.dark-only}

Each change made that day to an [alert](./alerts.md) on the queue is a row at the time it happened, linked to the alert. An alert opened on an earlier day and still open at 00:00 has a row at 00:00 with the day it opened. Alerts don't change a day's color or a queue's uptime, which come only from the recorded verdicts. A green day isn't clickable even when an alert changed that day.

## Uptime

A queue's uptime is the share of its recorded time over the days shown that it wasn't stalled or falling behind. Time absorbing a spike or recovering counts as up. A queue with nothing recorded has no uptime, because time with no verdict recorded counts neither way.
