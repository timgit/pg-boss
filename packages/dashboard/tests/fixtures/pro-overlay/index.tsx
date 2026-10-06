import { useMemo } from 'react'
import type { Instance } from '~/lib/types'
import type {
  InstanceAssessment,
  InstanceSlotProps,
  InstancesOverviewProps,
  ProOverlay,
} from '~/lib/pro-contract'

function DemoIcon ({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" />
}

function DemoFooter () {
  return <div data-testid="pro-footer">overlay footer</div>
}

// A name that starts "bad" is critical, "meh" watch; the rest are fine.
const rankOf = (name: string) => (name.startsWith('bad') ? 0 : name.startsWith('meh') ? 1 : 2)

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
