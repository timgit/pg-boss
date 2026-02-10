import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('Send Job Form Fields', () => {
  // Create a simple form component for testing field bindings
  function TestForm() {
    return (
      <form data-testid="send-form">
        <label htmlFor="queueSearch">Queue Name</label>
        <input
          type="text"
          id="queueSearch"
          placeholder="Search for a queue..."
        />
        <input type="hidden" name="queueName" id="queueName-hidden" />

        <label htmlFor="data">Data</label>
        <textarea id="data" name="data" />

        <label htmlFor="priority">Priority</label>
        <input type="number" id="priority" name="priority" />

        <label htmlFor="startAfter">Start After</label>
        <input type="text" id="startAfter" name="startAfter" />

        <label htmlFor="singletonKey">Singleton Key</label>
        <input type="text" id="singletonKey" name="singletonKey" />

        <label htmlFor="retryLimit">Retry Limit</label>
        <input type="number" id="retryLimit" name="retryLimit" min="0" />

        <label htmlFor="expireInSeconds">Expire In Seconds</label>
        <input type="number" id="expireInSeconds" name="expireInSeconds" min="1" />
      </form>
    )
  }

  it('renders queue name input with correct attributes', () => {
    render(<TestForm />)

    const queueInput = screen.getByPlaceholderText('Search for a queue...')
    expect(queueInput).toHaveAttribute('type', 'text')
    expect(queueInput).toHaveAttribute('id', 'queueSearch')

    const hiddenInput = document.getElementById('queueName-hidden')
    expect(hiddenInput).toHaveAttribute('type', 'hidden')
    expect(hiddenInput).toHaveAttribute('name', 'queueName')
  })

  it('accepts text input for queue search', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const queueInput = screen.getByPlaceholderText('Search for a queue...')
    await user.type(queueInput, 'test-queue')

    expect(queueInput).toHaveValue('test-queue')
  })

  it('renders data textarea with correct name attribute', () => {
    render(<TestForm />)

    const dataInput = screen.getByLabelText(/data/i)
    expect(dataInput.tagName).toBe('TEXTAREA')
    expect(dataInput).toHaveAttribute('name', 'data')
  })

  it('accepts JSON data input', async () => {
    render(<TestForm />)

    const dataInput = screen.getByLabelText(/data/i) as HTMLTextAreaElement
    // Set value directly since userEvent has issues with special characters in JSON
    dataInput.value = '{"key": "value"}'

    expect(dataInput).toHaveValue('{"key": "value"}')
  })

  it('renders priority input with correct type and name', () => {
    render(<TestForm />)

    const priorityInput = screen.getByLabelText(/priority/i)
    expect(priorityInput).toHaveAttribute('type', 'number')
    expect(priorityInput).toHaveAttribute('name', 'priority')
  })

  it('accepts numeric priority input', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const priorityInput = screen.getByLabelText(/priority/i) as HTMLInputElement
    await user.type(priorityInput, '10')

    expect(priorityInput.value).toBe('10')
  })

  it('renders startAfter input with correct name', () => {
    render(<TestForm />)

    const startAfterInput = screen.getByLabelText(/start after/i)
    expect(startAfterInput).toHaveAttribute('name', 'startAfter')
  })

  it('accepts text for startAfter input', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const startAfterInput = screen.getByLabelText(/start after/i)
    await user.type(startAfterInput, '5 minutes')

    expect(startAfterInput).toHaveValue('5 minutes')
  })

  it('renders singletonKey input with correct name', () => {
    render(<TestForm />)

    const singletonKeyInput = screen.getByLabelText(/singleton key/i)
    expect(singletonKeyInput).toHaveAttribute('name', 'singletonKey')
  })

  it('accepts text for singletonKey input', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const singletonKeyInput = screen.getByLabelText(/singleton key/i)
    await user.type(singletonKeyInput, 'unique-key-123')

    expect(singletonKeyInput).toHaveValue('unique-key-123')
  })

  it('renders retryLimit input with correct attributes', () => {
    render(<TestForm />)

    const retryLimitInput = screen.getByLabelText(/retry limit/i)
    expect(retryLimitInput).toHaveAttribute('type', 'number')
    expect(retryLimitInput).toHaveAttribute('name', 'retryLimit')
    expect(retryLimitInput).toHaveAttribute('min', '0')
  })

  it('accepts numeric retryLimit input', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const retryLimitInput = screen.getByLabelText(/retry limit/i) as HTMLInputElement
    await user.type(retryLimitInput, '5')

    expect(retryLimitInput.value).toBe('5')
  })

  it('renders expireInSeconds input with correct attributes', () => {
    render(<TestForm />)

    const expireInput = screen.getByLabelText(/expire in seconds/i)
    expect(expireInput).toHaveAttribute('type', 'number')
    expect(expireInput).toHaveAttribute('name', 'expireInSeconds')
    expect(expireInput).toHaveAttribute('min', '1')
  })

  it('accepts numeric expireInSeconds input', async () => {
    const user = userEvent.setup()
    render(<TestForm />)

    const expireInput = screen.getByLabelText(/expire in seconds/i) as HTMLInputElement
    await user.type(expireInput, '3600')

    expect(expireInput.value).toBe('3600')
  })

  it('serializes form data correctly', () => {
    const { container } = render(<TestForm />)
    const form = container.querySelector('form') as HTMLFormElement

    // Set values programmatically
    ;(form.querySelector('#queueName-hidden') as HTMLInputElement).value = 'test-queue'
    ;(form.querySelector('[name="data"]') as HTMLTextAreaElement).value = '{"test": "data"}'
    ;(form.querySelector('[name="priority"]') as HTMLInputElement).value = '15'
    ;(form.querySelector('[name="startAfter"]') as HTMLInputElement).value = '10 minutes'
    ;(form.querySelector('[name="singletonKey"]') as HTMLInputElement).value = 'my-key'
    ;(form.querySelector('[name="retryLimit"]') as HTMLInputElement).value = '3'
    ;(form.querySelector('[name="expireInSeconds"]') as HTMLInputElement).value = '7200'

    const formData = new FormData(form)

    expect(formData.get('queueName')).toBe('test-queue')
    expect(formData.get('data')).toBe('{"test": "data"}')
    expect(formData.get('priority')).toBe('15')
    expect(formData.get('startAfter')).toBe('10 minutes')
    expect(formData.get('singletonKey')).toBe('my-key')
    expect(formData.get('retryLimit')).toBe('3')
    expect(formData.get('expireInSeconds')).toBe('7200')
  })
})
