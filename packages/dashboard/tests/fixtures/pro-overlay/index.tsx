import type { ProOverlay } from '~/lib/pro-contract'

function DemoIcon ({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" />
}

function DemoFooter () {
  return <div data-testid="pro-footer">overlay footer</div>
}

/** Runtime half of a fixture overlay. Resolved through the `~pro` alias. */
export const overlay: ProOverlay = {
  nav: [
    { name: 'Demo', href: '/pro-demo', icon: DemoIcon },
  ],
  slots: {
    sidebarFooter: DemoFooter,
  },
}

export default overlay
