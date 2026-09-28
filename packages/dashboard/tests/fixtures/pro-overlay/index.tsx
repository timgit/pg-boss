import type {
  ProOverlay,
  StatsChartMarkersProps,
  StatsOverviewKpiProps,
  StatsQueueKpiProps,
  StatsTileProps,
} from '~/lib/pro-contract'

function DemoIcon ({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" />
}

function DemoFooter () {
  return <div data-testid="pro-footer">overlay footer</div>
}

function DemoQueueKpi ({ queue }: StatsQueueKpiProps) {
  return <div data-testid="pro-stats-queue-kpi">{queue.name} {queue.interval} {queue.points.length} points</div>
}

function DemoOverviewKpi ({ queues }: StatsOverviewKpiProps) {
  return <div data-testid="pro-stats-overview-kpi">{queues.map((q) => q.name).join(',')}</div>
}

// A queue whose name starts "bad" is critical, "meh" watch; the rest are fine.
const rankOf = (name: string) => (name.startsWith('bad') ? 0 : name.startsWith('meh') ? 1 : 2)

function DemoTileBadge ({ queue }: StatsTileProps) {
  return <span data-testid="pro-stats-tile-badge">{['critical', 'watch', 'ok'][rankOf(queue.name)]}</span>
}

function DemoMarkers ({ queue, chart, from, to, plot }: StatsChartMarkersProps) {
  return <div data-testid="pro-stats-markers">{queue ?? 'all'} {chart} {from}-{to} at {plot.left}+{plot.width}</div>
}

/** Runtime half of a fixture overlay. Resolved through the `~pro` alias. */
export const overlay: ProOverlay = {
  nav: [
    { name: 'Demo', href: '/pro-demo', icon: DemoIcon },
  ],
  slots: {
    sidebarFooter: DemoFooter,
    statsQueueKpi: DemoQueueKpi,
    statsOverviewKpi: DemoOverviewKpi,
    statsQueueTile: {
      Badge: DemoTileBadge,
      assess: ({ queue }) => {
        const rank = rankOf(queue.name)
        return { rank, severity: rank === 0 ? 'critical' : rank === 1 ? 'watch' : null }
      },
      sortLabel: 'Worst first',
    },
    statsChartMarkers: DemoMarkers,
  },
}

export default overlay
