import { useMemo } from 'react'
import type { Instance } from '~/lib/types'
import type {
  InstanceAssessment,
  InstanceSlotProps,
  InstancesOverviewProps,
  ProOverlay,
  StatsChartMarkersProps,
  StatsOverviewKpiProps,
  StatsQueueKpiProps,
  StatsQueuePanelsProps,
  StatsQueueSeries,
  StatsTileAssessment,
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

function DemoPanels ({ queue, range, syncKey, noun }: StatsQueuePanelsProps) {
  return <div data-testid="pro-stats-panels">{queue.name} {range[0]}-{range[1]} {syncKey} {noun} {queue.latency ? 'with latency' : 'no latency'}</div>
}

function DemoOverviewKpi ({ queues }: StatsOverviewKpiProps) {
  return <div data-testid="pro-stats-overview-kpi">{queues.map((q) => q.name).join(',')}</div>
}

// A queue whose name starts "bad" is critical, "meh" watch; the rest are fine.
const rankOf = (name: string) => (name.startsWith('bad') ? 0 : name.startsWith('meh') ? 1 : 2)

function useDemoAssessments (queues: StatsQueueSeries[]): ReadonlyMap<string, StatsTileAssessment> {
  return useMemo(() => new Map(queues.map((queue) => {
    const rank = rankOf(queue.name)
    return [queue.name, {
      rank,
      severity: rank === 0 ? 'critical' : rank === 1 ? 'watch' : null,
      badge: <span data-testid="pro-stats-tile-badge">{['critical', 'watch', 'ok'][rank]}</span>,
      line: <span data-testid="pro-stats-tile-line">{queue.latency ? 'p95 wait known' : 'no wait times'}</span>,
    }]
  })), [queues])
}

function DemoMarkers ({ queue, chart, from, to, bucketSeconds, plot }: StatsChartMarkersProps) {
  return <div data-testid="pro-stats-markers">{queue ?? 'all'} {chart} {from}-{to} by {bucketSeconds} at {plot.left}+{plot.width}</div>
}

function DemoInstancesOverview ({ instances, checkedOn }: InstancesOverviewProps) {
  return <div data-testid="pro-instances-overview">{instances.length} instances at {checkedOn.toISOString()}</div>
}

// An instance named "bad" is critical, "meh" watch and on an odd version; the rest are fine.
function useDemoInstanceAssessments (instances: Instance[]): ReadonlyMap<string, InstanceAssessment> {
  return useMemo(() => new Map(instances.map((instance) => {
    const rank = rankOf(instance.name ?? '')
    return [instance.id, { rank, severity: rank === 0 ? 'critical' : rank === 1 ? 'watch' : null, flagVersion: rank === 1 }]
  })), [instances])
}

function DemoPoolCell ({ instance }: InstanceSlotProps) {
  return <span data-testid="pro-instance-pool">{instance.poolTotal}/{instance.poolMax}</span>
}

function DemoInstanceDetail ({ instance }: InstanceSlotProps) {
  return <div data-testid="pro-instance-detail">{instance.host} pid {instance.pid}</div>
}

/** Runtime half of a fixture overlay. Resolved through the `~pro` alias. */
export const overlay: ProOverlay = {
  nav: [
    { name: 'Demo', href: '/pro-demo', icon: DemoIcon },
  ],
  slots: {
    sidebarFooter: DemoFooter,
    statsQueueKpi: DemoQueueKpi,
    statsQueuePanels: DemoPanels,
    statsOverviewKpi: DemoOverviewKpi,
    statsQueueTile: {
      useAssessments: useDemoAssessments,
      sortLabel: 'Worst first',
    },
    statsChartMarkers: DemoMarkers,
    instancesOverview: DemoInstancesOverview,
    instancesList: {
      useAssessments: useDemoInstanceAssessments,
      sortLabel: 'Worst first',
      columns: [{ header: 'Pool', align: 'right', Cell: DemoPoolCell }],
      Detail: DemoInstanceDetail,
    },
  },
}

export default overlay
