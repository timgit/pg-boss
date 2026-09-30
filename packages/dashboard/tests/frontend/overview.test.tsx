import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { OverviewSections } from '~/components/overview'
import type { OverviewData } from '~/lib/overview.server'
import type { QueueResult, WarningResult } from '~/lib/types'

// The free sections, whatever the build: a Pro build mounts its overlay at `~pro`.
vi.mock('~pro', () => ({ default: { nav: [], slots: {} } }))

const queue = (name: string, queuedCount: number): QueueResult => ({
  name,
  queuedCount,
  activeCount: 1,
  readyCount: queuedCount,
  failedCount: 0,
  deferredCount: 0,
  totalCount: queuedCount,
  readyHistory: null,
} as unknown as QueueResult)

const warning: WarningResult = { id: 1, type: 'queue_backlog', message: 'emails has 900 queued', data: { queue: 'emails' }, createdOn: new Date() }

const data = {
  stats: { totalQueued: 900, totalDeferred: 0, totalReady: 900, totalActive: 2, totalFailed: 7, totalJobs: 1000 },
  warnings: [warning],
  topQueues: [queue('emails', 900), queue('reports', 40)],
  migrations: { pending: 0, inProgress: 0, failed: 0 },
  queueStats: { totalQueues: 2, problemQueues: 0 },
} as unknown as OverviewData

function renderSections (extensions?: Parameters<typeof OverviewSections>[0]['extensions']) {
  return render(
    <MemoryRouter>
      <OverviewSections data={data} extensions={extensions} />
    </MemoryRouter>
  )
}

const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent)

describe('OverviewSections', () => {
  it('is the free overview without extensions', () => {
    renderSections()

    expect(screen.getByText('Top Queues')).toBeInTheDocument()
    expect(headers()).toEqual(['Name', 'Queued', 'Active', 'Trend', 'Status'])
  })

  it('takes an overlay\'s title, link, columns, stat footers and warning footer', () => {
    renderSections({
      statFooters: { totalFailed: <span>+7 in the last hour</span> },
      queues: {
        title: 'Queues, worst first',
        more: { to: '/stats', text: 'All on Stats' },
        afterName: [{ header: 'Health', cell: (q) => `health of ${q.name}` }],
        afterActive: [{ header: 'p95 wait', align: 'right', cell: () => '4 s' }],
        hideStatus: true,
      },
      WarningFooter: ({ warning: w }) => <span>footer for {w.message}</span>,
    })

    expect(screen.getByText('Queues, worst first')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'All on Stats' })).toHaveAttribute('href', '/stats')
    expect(headers()).toEqual(['Name', 'Health', 'Queued', 'Active', 'p95 wait', 'Trend'])
    expect(screen.getByText('health of reports')).toBeInTheDocument()
    expect(screen.getByText('+7 in the last hour')).toBeInTheDocument()
    expect(screen.getByText('footer for emails has 900 queued')).toBeInTheDocument()
  })
})
