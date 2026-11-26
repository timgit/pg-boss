import { Pause } from 'lucide-react'
import { Badge } from '~/components/ui/badge'

/** Beside a queue's name while `pauseQueue()` holds it. Renders nothing for a running queue. */
export function PausedBadge ({ paused }: { paused: boolean | undefined }) {
  if (!paused) return null
  return (
    <span title="Workers fetch no jobs from this queue until it resumes. Sends still add jobs." className="inline-flex">
      <Badge variant="warning" size="sm">
        <Pause className="h-3 w-3" aria-hidden="true" />
        Paused
      </Badge>
    </span>
  )
}
