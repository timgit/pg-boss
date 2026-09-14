import type { ProServerOverlay } from '~/lib/pro-contract'

/**
 * The no-op server overlay every build resolves to unless `PGBOSS_PRO=1` selects
 * one. The server-side counterpart of `pro-stub.ts`, kept separate so the Node
 * bundle never reaches a module that imports React.
 */
export const serverOverlay: ProServerOverlay = {}

export default serverOverlay
