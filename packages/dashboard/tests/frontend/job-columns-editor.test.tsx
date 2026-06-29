import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { JobColumnsEditor } from '~/components/job-columns-editor'
import { DEFAULT_JOB_COLUMNS, type JobColumn } from '~/lib/job-columns'

function renderEditor (
  columns: JobColumn[] = DEFAULT_JOB_COLUMNS,
  onColumnsChange = vi.fn()
) {
  render(
    <JobColumnsEditor
      columns={columns}
      getShareUrl={() => 'http://example.com/jobs'}
      onColumnsChange={onColumnsChange}
    />
  )
  return { onColumnsChange }
}

describe('JobColumnsEditor', () => {
  it('offers known sources in a dropdown while keeping the source editable', async () => {
    const user = userEvent.setup()
    const { onColumnsChange } = renderEditor()

    await user.click(screen.getByRole('button', { name: /Manage view/i }))
    await user.click(screen.getAllByRole('button', { name: /Show source options/i })[0])
    await user.click(screen.getByRole('option', { name: 'groupId' }))
    await user.click(screen.getByRole('button', { name: /Apply columns/i }))

    expect(onColumnsChange).toHaveBeenCalledWith([
      { path: 'groupId', name: 'Group ID' },
      ...DEFAULT_JOB_COLUMNS.slice(1),
    ])
  })

  it('allows a JSON path to be typed by hand', async () => {
    const user = userEvent.setup()
    const { onColumnsChange } = renderEditor([
      { path: 'data.myField', name: 'data.myField' },
    ])

    await user.click(screen.getByRole('button', { name: /Manage view/i }))
    const sourceInput = screen.getByLabelText('Column source')
    await user.clear(sourceInput)
    await user.type(sourceInput, 'output.status')
    await user.click(screen.getByRole('button', { name: /Apply columns/i }))

    expect(onColumnsChange).toHaveBeenCalledWith([
      { path: 'output.status', name: 'output.status' },
    ])
  })
})
