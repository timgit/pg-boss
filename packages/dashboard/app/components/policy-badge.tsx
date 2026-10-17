import { Badge } from '~/components/ui/badge'

/** A queue's policy, the same badge wherever a policy is shown. A queue with none is standard. */
export function PolicyBadge ({ policy }: { policy: string | null | undefined }) {
  return <Badge variant="gray" size="sm">{policy || 'standard'}</Badge>
}
