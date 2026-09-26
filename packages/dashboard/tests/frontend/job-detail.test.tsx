import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import {
  ConfigCard,
  CopyButton,
  DeadLetterPanel,
  FailurePanel,
  LineageCard,
  PayloadCard,
  RetriesCard,
  RunningPanel,
  StateBadge,
  TimelineCard,
  useLiveNow,
  type LineageProps,
} from '~/components/job-detail'
import type { LinkedJob } from '~/lib/queries.server'
import type { JobTimes } from '~/lib/job-detail'

const ROOT = 'da3b213d-a84b-4b56-95e4-b0d638406229'
const SOURCE = '82369a8d-5b28-467a-967e-f0a8c0ae61ff'
const THIS = '4d2fc193-d0f1-40d7-8b9f-7db732a44487'

function linked (id: string, overrides: Partial<LinkedJob> = {}): LinkedJob {
  return {
    id,
    name: 'emails',
    state: 'failed',
    createdOn: new Date('2026-09-26T16:28:00Z'),
    startedOn: new Date('2026-09-26T16:28:01Z'),
    completedOn: new Date('2026-09-26T16:28:02Z'),
    retryCount: 0,
    output: { message: 'SMTP 421 try again later' },
    ...overrides,
  }
}

function lineage (overrides: Partial<LineageProps> = {}) {
  const props: LineageProps = {
    jobId: THIS,
    queueName: 'emails-dlq',
    state: 'created',
    sourceName: 'emails',
    sourceId: SOURCE,
    sourceRootId: ROOT,
    sourceCreatedOn: new Date('2026-09-26T16:28:00Z'),
    sourceRetryCount: 0,
    sourceOutput: { message: 'SMTP 421 try again later' },
    rootQueue: 'emails',
    root: linked(ROOT, { output: { message: 'SMTP 550 mailbox unavailable' } }),
    source: linked(SOURCE),
    ...overrides,
  }
  return render(<MemoryRouter><LineageCard {...props} /></MemoryRouter>)
}

describe('LineageCard', () => {
  it('renders nothing for a job with no lineage', () => {
    const { container } = lineage({ sourceName: null, sourceId: null, sourceRootId: null })
    expect(container).toBeEmptyDOMElement()
  })

  it("opens on the source's timeline", () => {
    lineage()
    expect(screen.getByRole('button', { name: /^Source/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(SOURCE)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open job/ })).toHaveAttribute('href', `/queues/emails/jobs/${SOURCE}`)
  })

  it('switches to the root when it is selected, and closes', async () => {
    const user = userEvent.setup()
    lineage()

    await user.click(screen.getByRole('button', { name: /^Root/ }))
    expect(screen.getByText(ROOT)).toBeInTheDocument()
    expect(screen.getByText('SMTP 550 mailbox unavailable')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close root job timeline' }))
    expect(screen.queryByText(ROOT)).not.toBeInTheDocument()
  })

  it('draws a first dead-lettering as source and this job, without a root', () => {
    lineage({ sourceRootId: SOURCE, root: null })
    expect(screen.queryByRole('button', { name: /^Root/ })).not.toBeInTheDocument()
    expect(screen.getByText('dead-lettered')).toBeInTheDocument()
  })

  it('draws a redriven job as root and this job', () => {
    lineage({ sourceName: null, sourceId: null, source: null })
    expect(screen.getByRole('button', { name: /^Root/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('redriven')).toBeInTheDocument()
  })

  it('says so when the root is no longer stored', async () => {
    const user = userEvent.setup()
    lineage({ root: null })

    await user.click(screen.getByRole('button', { name: /^Root/ }))
    expect(screen.getByText(/isn't in emails any more/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open job/ })).not.toBeInTheDocument()
  })

  it("falls back to what was copied onto this job when the source is gone", () => {
    lineage({ source: null })
    const panel = screen.getByText('Source job').closest('div[id]') as HTMLElement
    expect(within(panel).getByText('no longer stored')).toBeInTheDocument()
    expect(within(panel).getAllByText('not kept')).toHaveLength(2)
    expect(within(panel).getByText('SMTP 421 try again later')).toBeInTheDocument()
  })
})

describe('PayloadCard', () => {
  it("leads with a completed job's output", () => {
    render(<PayloadCard data={{ n: 1 }} output={{ total: 3 }} state="completed" />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(t => t.textContent)).toEqual(['Output', 'Data'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('leads with data otherwise, and says when output will arrive', async () => {
    const user = userEvent.setup()
    render(<PayloadCard data={{ n: 1 }} output={null} state="active" />)
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Data')

    await user.click(screen.getByRole('tab', { name: /Output/ }))
    expect(screen.getByText('Output is written when the job finishes.')).toBeInTheDocument()
  })
})

describe('RunningPanel', () => {
  const started = new Date('2026-09-26T17:00:00Z')
  const running: JobTimes = {
    state: 'active',
    createdOn: started,
    startAfter: started,
    startedOn: started,
    completedOn: null,
    keepUntil: null,
    retryCount: 0,
    retryLimit: 2,
    expireInSeconds: 900,
    deleteAfterSeconds: 604_800,
  }

  it('counts up the run and down to the time limit', () => {
    render(<RunningPanel job={running} now={new Date(started.getTime() + 72_000)} heartbeatOn={null} heartbeatSeconds={30} />)
    expect(screen.getByRole('timer')).toHaveTextContent('1m 12s')
    expect(screen.getByText('13m 48s')).toBeInTheDocument()
    expect(screen.getByText('None received yet')).toBeInTheDocument()
  })

  it('says when a job has run past its time limit', () => {
    render(<RunningPanel job={running} now={new Date(started.getTime() + 960_000)} heartbeatOn={null} heartbeatSeconds={null} />)
    expect(screen.getByText('Past its time limit')).toBeInTheDocument()
    expect(screen.getByText('1m 00s over')).toBeInTheDocument()
  })
})

describe('TimelineCard', () => {
  it('lists what the row supports, ending with when the job is deleted', () => {
    const created = new Date('2026-09-26T17:00:00Z')
    render(
      <TimelineCard
        now={new Date(created.getTime() + 60_000)}
        job={{
          state: 'failed',
          createdOn: created,
          startAfter: created,
          startedOn: new Date(created.getTime() + 1000),
          completedOn: new Date(created.getTime() + 43_000),
          keepUntil: null,
          retryCount: 2,
          retryLimit: 2,
          expireInSeconds: 900,
          deleteAfterSeconds: 604_800,
        }}
      />
    )
    const items = screen.getAllByRole('listitem').map(li => li.textContent)
    expect(items[1]).toContain('Retried 2 times')
    expect(items[2]).toContain('Last attempt started')
    expect(items[3]).toContain('last attempt ran 42 s')
    expect(items[4]).toContain('7 days after failing')
  })
})

describe('RetriesCard', () => {
  it('shows retries used, delay and backoff', () => {
    render(<RetriesCard retryCount={1} retryLimit={3} retryDelay={30} retryBackoff retryDelayMax={600} />)
    expect(screen.getByText('30 s')).toBeInTheDocument()
    expect(screen.getByText('On, up to 10 min')).toBeInTheDocument()
  })

  it('says None and Off when retries are immediate', () => {
    render(<RetriesCard retryCount={0} retryLimit={0} retryDelay={0} retryBackoff={false} />)
    expect(screen.getByText('None')).toBeInTheDocument()
    expect(screen.getByText('Off')).toBeInTheDocument()
  })
})

describe('ConfigCard', () => {
  it('lists the settings a job has and names the ones it does not', () => {
    render(<ConfigCard rows={[{ label: 'Priority', value: 5, mono: true }]} unset={['singleton key', 'group']} />)
    expect(screen.getByText('Priority').nextSibling).toHaveTextContent('5')
    expect(screen.getByText('singleton key, group')).toBeInTheDocument()
  })
})

describe('FailurePanel', () => {
  it('leads with the error and links the dead letter queue it went to', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <FailurePanel output={{ error: 'report generator timed out', after: '30s' }} attempt={3} maxAttempts={3} deadLetter="reports-dlq" />
      </MemoryRouter>
    )
    expect(screen.getByText('report generator timed out')).toBeInTheDocument()
    expect(screen.getByText(/Attempt 3 of 3/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'reports-dlq' })).toHaveAttribute('href', '/queues/reports-dlq')

    await user.click(screen.getByRole('button', { name: /Show full output/ }))
    expect(screen.getByRole('button', { name: /Hide full output/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('says when no message was recorded', () => {
    render(<MemoryRouter><FailurePanel output={null} attempt={1} maxAttempts={1} deadLetter={null} /></MemoryRouter>)
    expect(screen.getByText('No error message was recorded')).toBeInTheDocument()
    expect(screen.getByText(/No retries left/)).toBeInTheDocument()
  })

  it('does not claim the retries ran out when they did not', () => {
    render(<MemoryRouter><FailurePanel output="boom" attempt={1} maxAttempts={3} deadLetter={null} /></MemoryRouter>)
    expect(screen.queryByText(/No retries left/)).not.toBeInTheDocument()
    expect(screen.getByText(/It stays failed until someone retries it/)).toBeInTheDocument()
  })
})

describe('DeadLetterPanel', () => {
  it("explains where the job came from and links to its source while it exists", () => {
    render(
      <MemoryRouter>
        <DeadLetterPanel sourceName="emails" sourceId={SOURCE} sourceRetryCount={2} sourceOutput={{ message: 'SMTP 421' }} sourceExists />
      </MemoryRouter>
    )
    expect(screen.getByText('SMTP 421')).toBeInTheDocument()
    expect(screen.getByText(/after 3 attempts, then moved to this dead letter queue/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open source job/ })).toHaveAttribute('href', `/queues/emails/jobs/${SOURCE}`)
  })

  it('offers no link once the source is gone', () => {
    render(
      <MemoryRouter>
        <DeadLetterPanel sourceName="emails" sourceId={SOURCE} sourceRetryCount={0} sourceOutput={null} sourceExists={false} />
      </MemoryRouter>
    )
    expect(screen.getByText(/on its first attempt/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open source job/ })).not.toBeInTheDocument()
  })
})

describe('StateBadge', () => {
  it('pulses for an active job', () => {
    const { container } = render(<StateBadge state="active" />)
    expect(container.querySelector('.motion-safe\\:animate-ping')).not.toBeNull()
  })

  it('uses the plain dot otherwise', () => {
    const { container } = render(<StateBadge state="completed" />)
    expect(screen.getByText('completed')).toBeInTheDocument()
    expect(container.querySelector('.motion-safe\\:animate-ping')).toBeNull()
  })
})

describe('CopyButton', () => {
  it('copies its value and says so', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    render(<CopyButton value={THIS} label="Copy job ID" />)

    await user.click(screen.getByRole('button', { name: 'Copy job ID' }))
    expect(writeText).toHaveBeenCalledWith(THIS)
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Copied')
  })
})

describe('useLiveNow', () => {
  afterEach(() => { vi.useRealTimers() })

  it("starts at the server's time and ticks from there while live", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-26T17:00:00Z'))
    // The database is two minutes ahead of this browser.
    const { result } = renderHook(() => useLiveNow('2026-09-26T17:02:00.000Z', true))
    expect(result.current.toISOString()).toBe('2026-09-26T17:02:00.000Z')

    act(() => { vi.advanceTimersByTime(3000) })
    expect(result.current.toISOString()).toBe('2026-09-26T17:02:03.000Z')
  })

  it('stays put when not live', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useLiveNow('2026-09-26T17:02:00.000Z', false))

    act(() => { vi.advanceTimersByTime(3000) })
    expect(result.current.toISOString()).toBe('2026-09-26T17:02:00.000Z')
  })
})
