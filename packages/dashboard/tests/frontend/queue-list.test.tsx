import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueueList, ReadyChart, effectiveSort } from '~/components/queue-list'
import type { QueueListData } from '~/lib/queue-list.server'
import type { QueueResult } from '~/lib/types'

// The free page, whatever the build: a Pro build mounts its overlay at `~pro`.
vi.mock('~pro', () => ({ default: { nav: [], slots: {} } }))

const queue = (name: string, readyCount: number, readyHistory: number[] | null = [readyCount, 1, 0]): QueueResult => ({
  name,
  policy: 'standard',
  partition: false,
  queuedCount: readyCount + 2,
  deferredCount: 2,
  readyCount,
  activeCount: 3,
  failedCount: 4,
  totalCount: 100,
  blockedCount: 0,
  readyHistory,
} as unknown as QueueResult)

const data = (view: 'cards' | 'table', queues = [queue('emails', 900), queue('reports', 40)]): QueueListData => ({
  queues,
  totalCount: queues.length,
  pageSize: 50,
  page: 1,
  totalPages: 1,
  hasNextPage: false,
  hasPrevPage: false,
  filter: 'all',
  search: '',
  sort: null,
  dir: null,
  views: view === 'cards' ? ['cards', 'table'] : ['table'],
  view,
})

function renderList (d: QueueListData, extensions?: Parameters<typeof QueueList>[0]['extensions']) {
  return render(
    <MemoryRouter>
      <QueueList data={d} extensions={extensions} />
    </MemoryRouter>
  )
}

const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent)

describe('QueueList', () => {
  it('draws a card per queue with its ready, active and failed, opening the queue', () => {
    renderList(data('cards'))

    const card = screen.getByRole('link', { name: /emails/ })
    expect(card).toHaveAttribute('href', '/queues/emails')
    // The figure, and the chart's peak.
    expect(within(card).getAllByText('900')).toHaveLength(2)
    expect(within(card).getByText('ready')).toBeInTheDocument()
    expect(within(card).getByText('queued 902 · deferred 2 · total 100')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('abbreviates a card\'s large counts to fit, and keeps them in full in the table', () => {
    const big = { ...queue('firehose', 12_345_678), queuedCount: 12_345_680, totalCount: 98_765_432 }
    renderList(data('cards', [big]))

    const card = screen.getByRole('link', { name: /firehose/ })
    expect(within(card).getAllByText('12.3M')[0]).toHaveAttribute('title', '12,345,678')
    expect(within(card).getByText('queued 12.3M · deferred 2 · total 98.8M')).toBeInTheDocument()
  })

  it('draws a view an overlay offers in place of the cards, and lists it in the toggle', () => {
    const d = { ...data('cards'), views: ['cards', 'table', 'hive'], view: 'hive' }
    renderList(d, { views: [{ value: 'hive', label: 'Hive', render: (queues) => <p>{queues.length} in the hive</p> }] })

    expect(screen.getByText('2 in the hive')).toBeInTheDocument()
    expect(screen.getAllByRole('button').filter((b) => ['Cards', 'Table', 'Hive'].includes(b.textContent ?? '')).map((b) => b.textContent)).toEqual(['Cards', 'Table', 'Hive'])
    expect(screen.getByRole('button', { name: 'Hive' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('offers no cards and no view toggle on its own', () => {
    renderList(data('table'))

    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cards' })).toBeNull()
  })

  it('draws the free table without extensions', () => {
    renderList(data('table'))

    expect(headers()).toEqual(['Name', 'Ready', 'Trend', 'Queued', 'Deferred', 'Active', 'Failed', 'Total', 'Policy', 'Storage'])
  })

  it('offers most ready and name, most ready by default', () => {
    renderList(data('cards'))

    const sort = screen.getByRole('group', { name: 'Sort queues' })
    expect(within(sort).getAllByRole('button').map((b) => b.textContent)).toEqual(['Most ready', 'Name'])
    expect(within(sort).getByRole('button', { name: 'Most ready' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('takes an overlay\'s card figures, badge, border, chart, lines and footer', () => {
    renderList(data('cards'), {
      card: (q) => ({
        badge: <span>badge {q.name}</span>,
        severity: q.name === 'emails' ? 'critical' : null,
        figures: [{ value: '12', label: 'arriving/min' }],
        chart: <span>chart {q.name}</span>,
        lines: <span>lines {q.name}</span>,
        footer: <span>footer {q.name}</span>,
      }),
    })

    const card = screen.getByRole('link', { name: /badge emails/ })
    expect(within(card).getByText('arriving/min')).toBeInTheDocument()
    expect(within(card).queryByText('ready')).toBeNull()
    expect(within(card).getByText('chart emails')).toBeInTheDocument()
    expect(within(card).getByText('lines emails')).toBeInTheDocument()
    expect(within(card).getByText('footer emails')).toBeInTheDocument()
    expect(card.className).toContain('border-[var(--error-500)]')
    expect(screen.getByRole('link', { name: /badge reports/ }).className).toContain('border-[var(--border-default)]')
  })

  it('takes an overlay\'s table columns, trend, hidden columns, sorts and regions', () => {
    renderList(data('table'), {
      subtitle: 'how work moves',
      toolbar: <span>range switch</span>,
      above: <span>figures above</span>,
      below: <span>footnote below</span>,
      sorts: [{ value: 'attention', label: 'Needs attention' }],
      table: {
        columns: [
          { key: 'health', header: 'Health', after: 'name', cell: (q) => `health ${q.name}` },
          { key: 'arr', header: 'Arriving', align: 'right', after: 'trend', cell: () => '5' },
        ],
        trend: (q) => <span>trend {q.name}</span>,
        hide: ['deferred', 'total', 'storage'],
      },
    })

    expect(headers()).toEqual(['Name', 'Health', 'Ready', 'Trend', 'Arriving', 'Queued', 'Active', 'Failed', 'Policy'])
    expect(screen.getByText('health emails')).toBeInTheDocument()
    expect(screen.getByText('trend reports')).toBeInTheDocument()
    for (const text of ['how work moves', 'range switch', 'figures above', 'footnote below']) {
      expect(screen.getByText(text)).toBeInTheDocument()
    }
    const sort = screen.getByRole('group', { name: 'Sort queues' })
    expect(within(sort).getAllByRole('button').map((b) => b.textContent)).toEqual(['Needs attention', 'Most ready', 'Name'])
    expect(within(sort).getByRole('button', { name: 'Needs attention' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('effectiveSort', () => {
  it('is the URL\'s, else the overlay\'s first, else most ready', () => {
    expect(effectiveSort('name')).toBe('name')
    expect(effectiveSort(null, { sorts: [{ value: 'attention', label: 'Needs attention' }] })).toBe('attention')
    expect(effectiveSort(null)).toBe('ready')
  })
})

describe('ReadyChart', () => {
  it('says so when there is no history to draw', () => {
    render(<ReadyChart history={null} />)
    expect(screen.getByText('No ready history yet')).toBeInTheDocument()
  })

  it('labels the peak of the last hour', () => {
    render(<ReadyChart history={[5, 1200, 3]} />)
    expect(screen.getByText('1,200')).toBeInTheDocument()
    expect(screen.getByText('last hour')).toBeInTheDocument()
  })
})
