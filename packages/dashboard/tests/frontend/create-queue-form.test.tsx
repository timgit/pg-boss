import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Checkbox } from '~/components/ui/checkbox'

describe('Create Queue Form Fields', () => {
  // Create a simple form component for testing field bindings
  function TestForm({ initialPolicy = 'standard', initialPartition = 'false' }: { initialPolicy?: string, initialPartition?: string } = {}) {
    const [retryBackoff, setRetryBackoff] = useState(false)
    const [policy] = useState(initialPolicy)
    const [partition] = useState(initialPartition)

    return (
      <form data-testid="create-queue-form">
        <label htmlFor="queueName">Queue Name</label>
        <input type="text" id="queueName" name="queueName" required />

        <label htmlFor="policy-hidden">Policy</label>
        <input type="hidden" id="policy-hidden" name="policy" value={policy} readOnly />

        <label htmlFor="partition-hidden">Partition</label>
        <input type="hidden" id="partition-hidden" name="partition" value={partition} readOnly />

        <label htmlFor="deadLetterSearch">Dead Letter Queue</label>
        <input type="text" id="deadLetterSearch" />
        <input type="hidden" id="deadLetter-hidden" name="deadLetter" />

        <label htmlFor="warningQueueSize">Warning Queue Size</label>
        <input type="number" id="warningQueueSize" name="warningQueueSize" min="1" />

        <label htmlFor="retryLimit">Retry Limit</label>
        <input type="number" id="retryLimit" name="retryLimit" min="0" />

        <label htmlFor="retryDelay">Retry Delay (seconds)</label>
        <input type="number" id="retryDelay" name="retryDelay" min="0" />

        <Checkbox
          id="retryBackoff"
          name="retryBackoff"
          value="true"
          checked={retryBackoff}
          onChange={(e) => setRetryBackoff(e.target.checked)}
          label="Enable Exponential Backoff"
        />

        <label htmlFor="retryDelayMax">Max Retry Delay (seconds)</label>
        <input
          type="number"
          id="retryDelayMax"
          name="retryDelayMax"
          min="1"
          disabled={!retryBackoff}
        />

        <label htmlFor="expireInSeconds">Expire In Seconds</label>
        <input type="number" id="expireInSeconds" name="expireInSeconds" min="1" />

        <label htmlFor="retentionSeconds">Retention Seconds</label>
        <input type="number" id="retentionSeconds" name="retentionSeconds" min="1" />

        <label htmlFor="deleteAfterSeconds">Delete After Seconds</label>
        <input type="number" id="deleteAfterSeconds" name="deleteAfterSeconds" min="0" />
      </form>
    )
  }

  it('renders queue name input with correct attributes', () => {
    render(<TestForm />)

    const nameInput = screen.getByLabelText(/queue name/i)
    expect(nameInput).toHaveAttribute('type', 'text')
    expect(nameInput).toHaveAttribute('name', 'queueName')
    expect(nameInput).toHaveAttribute('required')
  })

  it('accepts text for queue name input', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const nameInput = screen.getByLabelText(/queue name/i)
    await user.type(nameInput, 'my-new-queue')

    expect(nameInput).toHaveValue('my-new-queue')
  })

  it('renders policy hidden input with default value', () => {
    render(<TestForm />)

    const policyInput = document.getElementById('policy-hidden')
    expect(policyInput).toHaveAttribute('type', 'hidden')
    expect(policyInput).toHaveAttribute('name', 'policy')
    expect(policyInput).toHaveValue('standard')
  })

  it('renders partition hidden input with default value', () => {
    render(<TestForm />)

    const partitionInput = document.getElementById('partition-hidden')
    expect(partitionInput).toHaveAttribute('type', 'hidden')
    expect(partitionInput).toHaveAttribute('name', 'partition')
    expect(partitionInput).toHaveValue('false')
  })

  it('renders dead letter queue search input', () => {
    render(<TestForm />)

    const dlqInput = screen.getByLabelText(/dead letter queue/i)
    expect(dlqInput).toHaveAttribute('type', 'text')
    expect(dlqInput).toHaveAttribute('id', 'deadLetterSearch')

    const hiddenInput = document.getElementById('deadLetter-hidden')
    expect(hiddenInput).toHaveAttribute('type', 'hidden')
    expect(hiddenInput).toHaveAttribute('name', 'deadLetter')
  })

  it('renders warning queue size input with correct attributes', () => {
    render(<TestForm />)

    const warningInput = screen.getByLabelText(/warning queue size/i)
    expect(warningInput).toHaveAttribute('type', 'number')
    expect(warningInput).toHaveAttribute('name', 'warningQueueSize')
    expect(warningInput).toHaveAttribute('min', '1')
  })

  it('accepts numeric warning queue size', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const warningInput = screen.getByLabelText(/warning queue size/i) as HTMLInputElement
    await user.type(warningInput, '1000')

    expect(warningInput.value).toBe('1000')
  })

  it('renders retry limit input with correct attributes', () => {
    render(<TestForm />)

    const retryLimitInput = screen.getByLabelText(/retry limit/i)
    expect(retryLimitInput).toHaveAttribute('type', 'number')
    expect(retryLimitInput).toHaveAttribute('name', 'retryLimit')
    expect(retryLimitInput).toHaveAttribute('min', '0')
  })

  it('accepts numeric retry limit', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const retryLimitInput = screen.getByLabelText(/retry limit/i) as HTMLInputElement
    await user.type(retryLimitInput, '5')

    expect(retryLimitInput.value).toBe('5')
  })

  it('renders retry delay input with correct attributes', () => {
    render(<TestForm />)

    const retryDelayInput = screen.getByLabelText(/^retry delay \(seconds\)$/i)
    expect(retryDelayInput).toHaveAttribute('type', 'number')
    expect(retryDelayInput).toHaveAttribute('name', 'retryDelay')
    expect(retryDelayInput).toHaveAttribute('min', '0')
  })

  it('accepts numeric retry delay', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const retryDelayInput = screen.getByLabelText(/^retry delay \(seconds\)$/i) as HTMLInputElement
    await user.type(retryDelayInput, '30')

    expect(retryDelayInput.value).toBe('30')
  })

  it('renders retry backoff checkbox', () => {
    render(<TestForm />)

    const backoffCheckbox = screen.getByLabelText(/enable exponential backoff/i)
    expect(backoffCheckbox).toHaveAttribute('type', 'checkbox')
    expect(backoffCheckbox).toHaveAttribute('name', 'retryBackoff')
    expect(backoffCheckbox).not.toBeChecked()
  })

  it('toggles retry backoff checkbox', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const backoffCheckbox = screen.getByLabelText(/enable exponential backoff/i)
    await user.click(backoffCheckbox)

    expect(backoffCheckbox).toBeChecked()
  })

  it('disables max retry delay when backoff is unchecked', () => {
    render(<TestForm />)

    const maxRetryDelayInput = screen.getByLabelText(/max retry delay \(seconds\)/i)
    expect(maxRetryDelayInput).toBeDisabled()
  })

  it('enables max retry delay when backoff is checked', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const backoffCheckbox = screen.getByLabelText(/enable exponential backoff/i)
    await user.click(backoffCheckbox)

    const maxRetryDelayInput = screen.getByLabelText(/max retry delay \(seconds\)/i)
    expect(maxRetryDelayInput).toBeEnabled()
  })

  it('accepts numeric max retry delay when enabled', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const backoffCheckbox = screen.getByLabelText(/enable exponential backoff/i)
    await user.click(backoffCheckbox)

    const maxRetryDelayInput = screen.getByLabelText(/max retry delay \(seconds\)/i) as HTMLInputElement
    await user.type(maxRetryDelayInput, '3600')

    expect(maxRetryDelayInput.value).toBe('3600')
  })

  it('renders expireInSeconds input with correct attributes', () => {
    render(<TestForm />)

    const expireInput = screen.getByLabelText(/expire in seconds/i)
    expect(expireInput).toHaveAttribute('type', 'number')
    expect(expireInput).toHaveAttribute('name', 'expireInSeconds')
    expect(expireInput).toHaveAttribute('min', '1')
  })

  it('accepts numeric expireInSeconds', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const expireInput = screen.getByLabelText(/expire in seconds/i) as HTMLInputElement
    await user.type(expireInput, '1800')

    expect(expireInput.value).toBe('1800')
  })

  it('renders retentionSeconds input with correct attributes', () => {
    render(<TestForm />)

    const retentionInput = screen.getByLabelText(/retention seconds/i)
    expect(retentionInput).toHaveAttribute('type', 'number')
    expect(retentionInput).toHaveAttribute('name', 'retentionSeconds')
    expect(retentionInput).toHaveAttribute('min', '1')
  })

  it('accepts numeric retentionSeconds', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const retentionInput = screen.getByLabelText(/retention seconds/i) as HTMLInputElement
    await user.type(retentionInput, '604800')

    expect(retentionInput.value).toBe('604800')
  })

  it('renders deleteAfterSeconds input with correct attributes', () => {
    render(<TestForm />)

    const deleteInput = screen.getByLabelText(/delete after seconds/i)
    expect(deleteInput).toHaveAttribute('type', 'number')
    expect(deleteInput).toHaveAttribute('name', 'deleteAfterSeconds')
    expect(deleteInput).toHaveAttribute('min', '0')
  })

  it('accepts numeric deleteAfterSeconds', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const deleteInput = screen.getByLabelText(/delete after seconds/i) as HTMLInputElement
    await user.type(deleteInput, '259200')

    expect(deleteInput.value).toBe('259200')
  })

  it('serializes form data correctly', async () => {
    const user = userEvent.setup()
    const { container } = render(<TestForm initialPolicy="singleton" initialPartition="true" />)
    const form = container.querySelector('form') as HTMLFormElement

    // Set values programmatically
    ;(form.querySelector('[name="queueName"]') as HTMLInputElement).value = 'full-queue'
    ;(form.querySelector('[name="deadLetter"]') as HTMLInputElement).value = 'dlq'
    ;(form.querySelector('[name="warningQueueSize"]') as HTMLInputElement).value = '500'
    ;(form.querySelector('[name="retryLimit"]') as HTMLInputElement).value = '3'
    ;(form.querySelector('[name="retryDelay"]') as HTMLInputElement).value = '60'
    ;(form.querySelector('[name="retryDelayMax"]') as HTMLInputElement).value = '1800'
    ;(form.querySelector('[name="expireInSeconds"]') as HTMLInputElement).value = '900'
    ;(form.querySelector('[name="retentionSeconds"]') as HTMLInputElement).value = '1209600'
    ;(form.querySelector('[name="deleteAfterSeconds"]') as HTMLInputElement).value = '604800'

    // Check the checkbox
    const backoffCheckbox = screen.getByLabelText(/enable exponential backoff/i)
    await user.click(backoffCheckbox)

    const formData = new FormData(form)

    expect(formData.get('queueName')).toBe('full-queue')
    expect(formData.get('policy')).toBe('singleton')
    expect(formData.get('partition')).toBe('true')
    expect(formData.get('deadLetter')).toBe('dlq')
    expect(formData.get('warningQueueSize')).toBe('500')
    expect(formData.get('retryLimit')).toBe('3')
    expect(formData.get('retryDelay')).toBe('60')
    expect(formData.get('retryBackoff')).toBe('true')
    expect(formData.get('retryDelayMax')).toBe('1800')
    expect(formData.get('expireInSeconds')).toBe('900')
    expect(formData.get('retentionSeconds')).toBe('1209600')
    expect(formData.get('deleteAfterSeconds')).toBe('604800')
  })
})
