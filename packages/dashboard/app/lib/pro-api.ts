/**
 * The dashboard's lib modules Pro imports, other than its `.server` modules. Pro's overlay imports
 * the dashboard only through this file, `pro-api.server.ts` and `components/pro-ui.ts`, and its
 * build refuses any other `~/` import.
 *
 * Nothing here reaches React components, CSS or a `.server` module. The overlay's server half and
 * Pro's Node scripts load this file. React must stay out of the `~pro-server` half.
 *
 * A name removed or renamed here breaks Pro. Keep the export, or change Pro in step.
 */

export { cspNonceContext } from '~/lib/csp-nonce'
export { formatCompact } from '~/lib/format'
export {
  endedOn,
  formatAgo,
  formatConfig,
  formatSpan,
  instanceName,
  instanceStatus,
  type InstanceSummary,
  isChangedOption,
  type ListedInstance,
  listInstances,
  OPTION_DEFAULTS,
} from '~/lib/instances'
export { attempts, type JobTimes, statusLine, summarizeOutput, timeAgo } from '~/lib/job-detail'
export { type ScopeHandle, showsSchema } from '~/lib/page-scope'
export type { TitleHandle } from '~/lib/page-title'
export type { ActionPage, ProOverlay, ProServerOverlay, ProSite } from '~/lib/pro-contract'
export { parsePublishForm } from '~/lib/publish-form'
export { waitingBreakdown } from '~/lib/queue-metrics'
export { SCHEMA_COLORS, type SchemaColor, schemaColor } from '~/lib/schema-colors'
export { schemaContext } from '~/lib/schema-context'
export { niceMax } from '~/lib/stats'
export { parseSubscriptionForm } from '~/lib/subscription-form'
export type {
  Backends,
  Connections,
  Instance,
  QueueResult,
  QueueStatsAggregate,
  QueueStatsPoint,
  QueueThroughputPoint,
  QueueThroughputSeries,
} from '~/lib/types'
export { cn, formatDate, formatTimeAgo, JOB_STATE_VARIANTS, resetPaging } from '~/lib/utils'
