import type { Route } from './+types/warnings.$id'
import { getWarning } from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Badge } from '~/components/ui/badge'
import { DbLink } from '~/components/db-link'
import { ErrorCard } from '~/components/error-card'
import { formatDateWithSeconds, formatTimeAgo, warningTypeLabel, warningTypeVariant } from '~/lib/utils'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: ({ params }) => (params.id ? `Warning ${params.id.slice(0, 8)}` : null) }

export async function loader ({ params, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  // Not a uuid is no warning, rather than a database error.
  const id = /^[0-9a-f-]{36}$/i.test(params.id) ? params.id : null
  const warning = id === null ? null : await getWarning(DB_URL, SCHEMA, id)

  if (!warning) {
    throw new Response('No such warning.', { status: 404, statusText: 'Not found' })
  }

  return { warning }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return <ErrorCard title="Failed to load the warning" error={error} backTo={{ href: '/warnings', label: 'Back to warnings' }} />
}

const linkClass = 'font-medium text-[var(--primary-600)] hover:underline dark:text-[var(--primary-400)]'

/** The queue a warning is about, when its data names one. */
function queueOf (data: unknown): string | null {
  const queue = data !== null && typeof data === 'object' ? (data as { queue?: unknown }).queue : null
  return typeof queue === 'string' && queue ? queue : null
}

export default function WarningDetail ({ loaderData }: Route.ComponentProps) {
  const { warning } = loaderData
  const createdOn = new Date(warning.createdOn)
  const queue = queueOf(warning.data)
  const hasData = warning.data !== null && warning.data !== undefined &&
    !(typeof warning.data === 'object' && Object.keys(warning.data as object).length === 0)

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Warning: ${warningTypeLabel(warning.type)}`}
        subtitle={`Recorded ${formatTimeAgo(createdOn)}`}
      />

      <Card>
        <CardContent className="grid gap-4 p-5">
          <p className="whitespace-pre-wrap break-words text-[15px] text-[var(--text-primary)]">{warning.message}</p>

          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
            <dt className="text-[var(--text-tertiary)]">Type</dt>
            <dd>
              <Badge variant={warningTypeVariant(warning.type)} size="sm" dot>{warningTypeLabel(warning.type)}</Badge>
              <DbLink to={`/warnings?type=${encodeURIComponent(warning.type)}`} className={`ml-3 ${linkClass}`}>
                Every warning of this type
              </DbLink>
            </dd>
            <dt className="text-[var(--text-tertiary)]">Recorded</dt>
            <dd className="pgb-num text-[var(--text-secondary)]">{formatDateWithSeconds(createdOn)}</dd>
            {queue && (
              <>
                <dt className="text-[var(--text-tertiary)]">Queue</dt>
                <dd><DbLink to={`/queues/${encodeURIComponent(queue)}`} className={linkClass}>{queue}</DbLink></dd>
              </>
            )}
            <dt className="text-[var(--text-tertiary)]">Id</dt>
            <dd className="pgb-num break-all text-[var(--text-secondary)]">{warning.id}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="p-5 pt-0">
          {hasData
            ? (
              <pre className="overflow-x-auto rounded-md bg-[var(--surface-sunken)] p-4 font-mono text-xs leading-relaxed text-[var(--text-secondary)]">
                {JSON.stringify(warning.data, null, 2)}
              </pre>
              )
            : <p className="text-sm text-[var(--text-tertiary)]">This warning was recorded without details.</p>}
        </CardContent>
      </Card>
    </div>
  )
}
