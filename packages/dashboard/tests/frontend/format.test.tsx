import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { formatCompact } from '~/lib/format'
import { Count } from '~/components/ui/count'

describe('formatCompact', () => {
  it('writes counts in full below 10,000 and abbreviates larger ones', () => {
    expect([0, 42, 9_999, 12_345, 1_234_567, 12_345_678, 2_500_000_000].map(formatCompact))
      .toEqual(['0', '42', '9,999', '12.3K', '1.2M', '12.3M', '2.5B'])
  })
})

describe('Count', () => {
  it('puts the full number on hover only when it was shortened', () => {
    render(<><Count value={1_234_567} /><Count value={812} /></>)

    expect(screen.getByText('1.2M')).toHaveAttribute('title', '1,234,567')
    expect(screen.getByText('812')).not.toHaveAttribute('title')
  })
})
