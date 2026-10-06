import type { ReactNode } from 'react'
import type { Route } from './+types/migrations.$id'
import { getBamEntry } from '~/lib/queries.server'
import { dbContext } from '~/lib/db-context'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { PageHeader } from '~/components/ui/page-header'
import { Badge } from '~/components/ui/badge'
import { DbLink } from '~/components/db-link'
import { ErrorCard } from '~/components/error-card'
import { formatSpan } from '~/lib/instances'
import { BAM_STATUS_LABELS, BAM_STATUS_VARIANTS, formatDateWithSeconds } from '~/lib/utils'
import type { TitleHandle } from '~/lib/page-title'

/** The browser tab's name for this page. */
export const handle: TitleHandle = { title: ({ params }) => (params.id ? `Migration ${params.id.slice(0, 8)}` : null) }

export async function loader ({ params, context }: Route.LoaderArgs) {
  const { DB_URL, SCHEMA } = context.get(dbContext)
  // Not a uuid is no migration, rather than a database error.
  const entry = /^[0-9a-f-]{36}$/i.test(params.id) ? await getBamEntry(DB_URL, SCHEMA, params.id) : null

  if (!entry) {
    throw new Response('No such migration.', { status: 404, statusText: 'Not found' })
  }

  return { entry, checkedOn: new Date().toISOString() }
}

export function ErrorBoundary ({ error }: Route.ErrorBoundaryProps) {
  return <ErrorCard title="Failed to load the migration" error={error} backTo={{ href: '/migrations', label: 'Back to migrations' }} />
}

const at = (value: Date | string | null) => (value ? formatDateWithSeconds(new Date(value)) : '—')

function Fact ({ term, children }: { term: string, children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-[var(--text-tertiary)]">{term}</dt>
      <dd className="pgb-num min-w-0 break-words text-[var(--text-secondary)]">{children}</dd>
    </div>
  )
}

export default function MigrationDetail ({ loaderData }: Route.ComponentProps) {
  const { entry } = loaderData
  const now = new Date(loaderData.checkedOn).getTime()
  const started = entry.startedOn ? new Date(entry.startedOn).getTime() : null
  const ended = entry.completedOn ? new Date(entry.completedOn).getTime() : null
  const took = started === null
    ? null
    : ended !== null ? `${formatSpan(ended - started)}` : entry.status === 'in_progress' ? `${formatSpan(now - started)} so far` : null

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Migration: ${entry.name}`}
        subtitle={`Schema version ${entry.version}, on ${entry.table}${entry.queue ? ` for ${entry.queue}` : ''}`}
      />

      <Card>
        <CardContent className="p-5">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
            <Fact term="Status">
              <Badge variant={BAM_STATUS_VARIANTS[entry.status]} size="sm" dot>{BAM_STATUS_LABELS[entry.status]}</Badge>
            </Fact>
            <Fact term="Version">{entry.version}</Fact>
            <Fact term="Table"><span className="font-mono text-xs">{entry.table}</span></Fact>
            <Fact term="Queue">
              {entry.queue
                ? <DbLink to={`/queues/${encodeURIComponent(entry.queue)}`} className="font-mono text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300">{entry.queue}</DbLink>
                : 'Every queue'}
            </Fact>
            <Fact term="Created">{at(entry.createdOn)}</Fact>
            <Fact term="Started">{at(entry.startedOn)}</Fact>
            <Fact term="Completed">{at(entry.completedOn)}</Fact>
            {took && <Fact term="Took">{took}</Fact>}
            <Fact term="Id"><span className="break-all">{entry.id}</span></Fact>
          </dl>
        </CardContent>
      </Card>

      {entry.error && (
        <Card>
          <CardHeader>
            <CardTitle>Error</CardTitle>
          </CardHeader>
          <CardContent className="p-5 pt-0">
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-sunken)] p-4 font-mono text-xs text-[var(--state-failed-fg)]">
              {entry.error}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Command</CardTitle>
        </CardHeader>
        <CardContent className="p-5 pt-0">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-sunken)] p-4 font-mono text-xs leading-relaxed text-[var(--text-secondary)]">
            {entry.command}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
