import { Inbox } from 'lucide-react'

/** Beside a queue's name, on its page and its jobs' pages, when another queue sends failed jobs to it. */
export function DeadLetterBadge () {
  return (
    <span
      title="At least one queue sends its failed jobs here"
      className="inline-flex items-center gap-1 rounded-full bg-[var(--state-failed-bg)] px-2 py-0.5 text-xs text-[var(--state-failed-fg)]"
    >
      <Inbox className="h-3 w-3" aria-hidden="true" />
      Dead letter queue
    </span>
  )
}
