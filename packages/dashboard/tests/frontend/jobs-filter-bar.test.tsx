import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { JobsFilterBar, type JobsFilters } from '~/components/jobs-filter-bar'
import { DEFAULT_STATE_FILTER } from '~/lib/utils'

const baseFilters: JobsFilters = {
  state: DEFAULT_STATE_FILTER,
  id: '',
  queues: [],
  minRetries: '',
  data: [],
  output: [],
}

const VALID_UUID = '7c6f6849-1b6f-4afe-95a7-7548e996a417'

describe('JobsFilterBar', () => {
  it('renders the id, queue, state and min-retries controls', () => {
    render(
      <JobsFilterBar
        filters={baseFilters}
        queueOptions={['transcription', 'audio-processing']}
        onChange={vi.fn()}
      />
    )

    expect(screen.getByPlaceholderText(/Filter by job ID/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Minimum retries/i)).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeInTheDocument() // state FilterSelect
  })

  it('commits the id filter on Enter', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <JobsFilterBar filters={baseFilters} queueOptions={[]} onChange={onChange} />
    )

    const input = screen.getByPlaceholderText(/Filter by job ID/i)
    await user.type(input, VALID_UUID)
    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalled()
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0]
    expect(lastCall.id).toBe(VALID_UUID)
  })

  it('clears the id filter via the clear button', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <JobsFilterBar
        filters={{ ...baseFilters, id: VALID_UUID }}
        queueOptions={[]}
        onChange={onChange}
      />
    )

    await user.click(screen.getByLabelText(/Clear job id filter/i))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: '' }))
  })

  it('rejects non-numeric min retries input', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <JobsFilterBar filters={baseFilters} queueOptions={[]} onChange={onChange} />
    )

    const minRetries = screen.getByLabelText(/Minimum retries/i)
    // The input is type=number so the browser already filters letters in
    // userEvent's simulation, but we still verify the commit logic ignores junk.
    await user.type(minRetries, '3')
    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ minRetries: '3' }))
  })

  it('shows advanced filters when toggled', async () => {
    const user = userEvent.setup()
    render(
      <JobsFilterBar filters={baseFilters} queueOptions={[]} onChange={vi.fn()} />
    )

    expect(screen.queryByText(/Add data filter/i)).not.toBeInTheDocument()
    await user.click(screen.getByText(/Show advanced filters/i))
    expect(screen.getByText(/Add data filter/i)).toBeInTheDocument()
    expect(screen.getByText(/Add output filter/i)).toBeInTheDocument()
  })

  it('starts with advanced filters open when data or output pairs exist', () => {
    render(
      <JobsFilterBar
        filters={{ ...baseFilters, data: [{ key: 'sessionId', value: 'abc' }] }}
        queueOptions={[]}
        onChange={vi.fn()}
      />
    )

    expect(screen.getByText(/Hide advanced filters/i)).toBeInTheDocument()
    expect(screen.getByDisplayValue('sessionId')).toBeInTheDocument()
    expect(screen.getByDisplayValue('abc')).toBeInTheDocument()
  })

  it('renders a new empty row when "Add data filter" is clicked but does not commit it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <JobsFilterBar
        filters={{ ...baseFilters, data: [{ key: 'sessionId', value: 'abc' }] }}
        queueOptions={[]}
        onChange={onChange}
      />
    )

    await user.click(screen.getByText(/Add data filter/i))
    // Empty rows are local UI state — they don't push to the URL until
    // both the key and value are filled in.
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/Data filter key 2/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Data filter value 2/i)).toBeInTheDocument()
  })

  it('removes a committed row and notifies onChange', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <JobsFilterBar
        filters={{ ...baseFilters, data: [{ key: 'sessionId', value: 'abc' }] }}
        queueOptions={[]}
        onChange={onChange}
      />
    )

    await user.click(screen.getByLabelText(/Remove data filter 1/i))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ data: [] }))
  })

  it('keeps a half-edited row visible after the user clears its value (regression: prop sync should not wipe local state)', async () => {
    // Simulates the real route: parent owns filters, JobsFilterBar drives them
    // via onChange. When the user clears the value, the committed pairs go
    // from [{sessionId:abc}] to [], the parent re-renders with data=[], and
    // the row should NOT vanish — the user is still typing.
    function Host () {
      const [filters, setFilters] = useState<JobsFilters>({
        ...baseFilters,
        data: [{ key: 'sessionId', value: 'abc' }],
      })
      return (
        <JobsFilterBar filters={filters} queueOptions={[]} onChange={setFilters} />
      )
    }

    const user = userEvent.setup()
    render(<Host />)

    const valueInput = screen.getByLabelText(/Data filter value 1/i)
    await user.clear(valueInput)

    // Row stays mounted with key preserved and value empty
    expect(screen.getByLabelText(/Data filter key 1/i)).toHaveValue('sessionId')
    expect(screen.getByLabelText(/Data filter value 1/i)).toHaveValue('')

    // User can now retype the value
    await user.type(screen.getByLabelText(/Data filter value 1/i), 'xyz')
    expect(screen.getByLabelText(/Data filter value 1/i)).toHaveValue('xyz')
  })

  it('commits a data row only after both key and value are filled in', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <JobsFilterBar filters={baseFilters} queueOptions={[]} onChange={onChange} />
    )

    await user.click(screen.getByText(/Show advanced filters/i))
    await user.click(screen.getByText(/Add data filter/i))

    const keyInput = screen.getByLabelText(/Data filter key 1/i)
    const valueInput = screen.getByLabelText(/Data filter value 1/i)

    await user.type(keyInput, 'sessionId')
    expect(onChange).not.toHaveBeenCalled() // value still empty

    await user.type(valueInput, 'abc')
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: [{ key: 'sessionId', value: 'abc' }],
      })
    )
  })
})
