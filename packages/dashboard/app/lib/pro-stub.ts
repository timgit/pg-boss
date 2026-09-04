import type { ProOverlay } from '~/lib/pro-contract'

/** The no-op overlay every build resolves to unless `PGBOSS_PRO=1` selects one. */
export const overlay: ProOverlay = {
  nav: [],
  slots: {},
}

export default overlay
