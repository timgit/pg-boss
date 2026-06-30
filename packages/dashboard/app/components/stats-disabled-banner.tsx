import { TriangleAlert } from 'lucide-react'
import { cn } from '~/lib/utils'

// Shown on the queue-detail and metrics surfaces when persisted queue stats history isn't being
// recorded, so the interactive chart and the failed-count trend would be empty. (The ready sparkline
// is always available from queue.ready_history and needs nothing.) The `queue_stats` table is created
// at schema v35 but stays empty until pg-boss is constructed with `persistQueueStats: true`; see
// getQueueStatsCollectionStatus in queries.server.ts.
export function StatsDisabledBanner ({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 rounded-[10px] border border-[var(--border-default)] px-4 py-3',
        className
      )}
      style={{ background: 'var(--state-retry-bg)' }}
    >
      <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-[var(--warning-600)]" aria-hidden="true" />
      <div className="text-sm">
        <p className="font-medium text-[var(--text-primary)]">Queue stats history isn&rsquo;t being recorded</p>
        <p className="mt-0.5 text-[var(--text-secondary)]">
          The interactive metrics chart and longer-range trends draw from recorded history. Enable it by constructing pg-boss with{' '}
          <code className="rounded bg-[var(--surface-card)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--text-primary)]">persistQueueStats: true</code> (optionally set{' '}
          <code className="rounded bg-[var(--surface-card)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--text-primary)]">queueStatRetentionDays</code>). New history is recorded each{' '}
          <code className="rounded bg-[var(--surface-card)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--text-primary)]">supervise</code> interval.
        </p>
      </div>
    </div>
  )
}
