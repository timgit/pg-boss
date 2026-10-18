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

function renderSections (extensions?: Parameters<typeof OverviewSections>[0]['extensions'], over: Partial<OverviewData> = {}) {
  return render(
    <MemoryRouter>
      <OverviewSections data={{ ...data, ...over }} extensions={extensions} />
    </MemoryRouter>
  )
}

const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent)

describe('OverviewSections', () => {
  it('is the free overview without extensions', () => {
    renderSections()

    expect(screen.getByText('Top Queues')).toBeInTheDocument()
    expect(headers()).toEqual(['Name', 'Ready', 'Trend', 'Active', 'Status'])
    expect(screen.getByText('Recent Warnings')).toBeInTheDocument()
    expect(screen.getByText('emails has 900 queued')).toBeInTheDocument()
  })

  it('reads Waiting for a queue with ready jobs and none active, and Idle for an empty one', () => {
    renderSections(undefined, {
      topQueues: [
        { ...queue('emails', 140), activeCount: 0 },
        { ...queue('reports', 0), activeCount: 0 },
        queue('exports', 12),
      ],
    })

    const status = (name: string) => within(screen.getByText(name).closest('tr')!).getAllByRole('cell').at(-1)!.textContent
    expect(status('emails')).toBe('Waiting')
    expect(status('reports')).toBe('Idle')
    expect(status('exports')).toBe('Processing')
  })

  it('leaves the warnings card out when loaded without warnings', () => {
    renderSections(undefined, { warnings: null })

    expect(screen.getByText('Top Queues')).toBeInTheDocument()
    expect(screen.queryByText('Recent Warnings')).not.toBeInTheDocument()
  })

  it('takes an overlay\'s title, link, columns and stat footers', () => {
    renderSections({
      statFooters: { totalFailed: <span>+7 in the last hour</span> },
      queues: {
        title: 'Queues, worst first',
        more: { to: '/stats', text: 'All on Stats' },
        afterName: [{ header: 'Health', cell: (q) => `health of ${q.name}` }],
        afterActive: [{ header: 'p95 wait', align: 'right', cell: () => '4 s' }],
        hideStatus: true,
      },
    })

    expect(screen.getByText('Queues, worst first')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'All on Stats' })).toHaveAttribute('href', '/stats')
    expect(headers()).toEqual(['Name', 'Health', 'Ready', 'Trend', 'Active', 'p95 wait'])
    expect(screen.getByText('health of reports')).toBeInTheDocument()
    expect(screen.getByText('+7 in the last hour')).toBeInTheDocument()
  })
})
