# Operations

**Operations** (`/pro/ops`) runs one verb (retry, cancel, resume or delete)
over every job matching a filter, instead of one at a time. It is the page for
the morning after a bad deploy.

Describe the set: queues, state, how long ago the jobs were created, how many
times they have been retried, and fields their `data` must contain. The page
recounts as you go and shows the exact number, a sentence saying what will
happen, how the matches split across queues, and a few of the actual jobs. The
queue picker takes typing, and each suggestion shows how many matches it adds.

Nothing runs until you press **Review**, which freezes the number, and then
the button that names it. The number is what you are agreeing to, not the
filter. If more jobs land in the set while you are reading the confirmation,
it refuses, shows the new count and asks again. Deleting 1,000 jobs or more
also asks you to type the number.

A few things worth knowing:

- Each verb only touches what it could touch on its own: retry acts on
  failures, resume on cancellations, cancel on anything unfinished, delete on
  everything. The count says the same, so it never promises more than it does.
- A payload value is read as JSON when it parses and as text otherwise, so
  `42` matches the number and `"42"` the string.
- Permissions are the single-job ones. Deleting needs `job:delete`, which
  only an administrator has; an operator is not offered it and cannot post it.
- Each recount is read-only and gives up after 10 seconds. On a very large job
  table, narrow to a queue or an age.
- Work happens in chunks beside your live queues, committing as it goes, so a
  large operation never holds locks for minutes. **Stop after this chunk**
  ends it there, keeping what has already been done.
- Every operation is in the audit log with who ran it, the filter it used,
  what it expected and what it actually changed.
- Deleted jobs are gone. There is no undo, and the page says so.

Filters you re-run can be saved by name and applied from the top of the page.

## Redrive

**Redrive** moves the jobs waiting in a dead letter queue back into work, as new
jobs, through pg-boss's own `redrive()`. It is offered when at least one queue
names another as its `deadLetter`, and it needs the same permission as retrying
a job.

Choose the dead letter queue, then where the jobs go: **back where each came
from** (the default), or **into another queue**. You can narrow it to the jobs
from one source queue, by payload, and by how long ago they were dead-lettered,
and cap the pace at 1,000, 100 or 10 jobs a second so a large redrive does not
flood the queue again. The summary shows how the jobs split across
destinations, and the first few it would move, with the error each one failed
with.

- Only waiting jobs are moved. A job that failed inside the dead letter queue
  stays there.
- A job with no source queue recorded (sent straight to the dead letter queue)
  stays put unless you choose a destination, and the page says how many.
- Each job is re-created: a new id, retry count 0, and the destination's current
  retry, retention and expiry settings. Flows do not resume.
- A job the destination refuses under its policy (`short`, `singleton`,
  `stately`) stays failed in the dead letter queue with the reason, and the
  history counts them and links to the queue.
- The number you confirm is a ceiling. Jobs dead-lettered after you confirm are
  not swept into the run.
- One redrive per dead letter queue runs at a time. A second is refused at
  confirm, not queued.

To open the page ready to redrive a queue, link to
`/pro/ops?verb=redrive&queue=<dead letter queue>`.
