import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useSearchParams } from 'react-router'
import { SortableHeader } from '~/components/ui/table'

function renderHeader (initial = '') {
  const setParams = vi.fn()
  vi.mocked(useSearchParams).mockReturnValue([new URLSearchParams(initial), setParams] as any)
  render(
    <table>
      <thead>
        <tr>
          <SortableHeader column="name">Name</SortableHeader>
        </tr>
      </thead>
    </table>
  )
  const clickedParams = () => {
    fireEvent.click(screen.getByRole('button', { name: /sort by name/i }))
    return setParams.mock.calls[0][0] as URLSearchParams
  }
  return { setParams, clickedParams }
}

describe('SortableHeader', () => {
  it('renders a labelled sort button for the column', () => {
    renderHeader()
    expect(screen.getByRole('button', { name: /sort by name/i })).toBeInTheDocument()
  })

  it('sorts ascending when an inactive column is clicked', () => {
    const params = renderHeader('').clickedParams()
    expect(params.get('sort')).toBe('name')
    expect(params.get('dir')).toBe('asc')
  })

  it('toggles to descending when the active ascending column is clicked', () => {
    const params = renderHeader('sort=name&dir=asc').clickedParams()
    expect(params.get('dir')).toBe('desc')
  })

  it('toggles back to ascending when the active descending column is clicked', () => {
    const params = renderHeader('sort=name&dir=desc').clickedParams()
    expect(params.get('dir')).toBe('asc')
  })

  it('resets pagination to the first page when sorting changes', () => {
    const params = renderHeader('page=3').clickedParams()
    expect(params.get('page')).toBeNull()
  })

  it('uses the full-name title for the tooltip and aria-label when abbreviated', () => {
    vi.mocked(useSearchParams).mockReturnValue([new URLSearchParams(), vi.fn()] as any)
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader column="deferred" title="Deferred">D</SortableHeader>
          </tr>
        </thead>
      </table>
    )
    const button = screen.getByRole('button', { name: /sort by deferred/i })
    expect(button).toHaveAttribute('title', 'Deferred')
    expect(button).toHaveTextContent('D')
  })
})
