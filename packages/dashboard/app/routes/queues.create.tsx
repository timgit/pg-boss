import { useState, useEffect } from 'react'
import { redirect, useActionData, useNavigation, useBlocker } from 'react-router'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues.create'
import { getQueues } from '~/lib/queries.server'
import { createQueue } from '~/lib/boss.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '~/components/ui/select'
import { ErrorCard } from '~/components/error-card'
import { cn } from '~/lib/utils'

export async function loader ({ context }: Route.LoaderArgs) {
  const queues = await getQueues(context.DB_URL, context.SCHEMA)
  return { queues }
}

export async function action ({ request, context }: Route.ActionArgs) {
  const formData = await request.formData()

  const queueName = formData.get('queueName') as string | null
  const policy = formData.get('policy') as string | null
  const partition = formData.get('partition') === 'true'
  const deadLetter = formData.get('deadLetter') as string | null
  const warningQueueSize = formData.get('warningQueueSize') as string | null
  const retryLimit = formData.get('retryLimit') as string | null
  const retryDelay = formData.get('retryDelay') as string | null
  const retryBackoff = formData.get('retryBackoff') === 'true'
  const retryDelayMax = formData.get('retryDelayMax') as string | null
  const expireInSeconds = formData.get('expireInSeconds') as string | null
  const retentionSeconds = formData.get('retentionSeconds') as string | null
  const deleteAfterSeconds = formData.get('deleteAfterSeconds') as string | null

  // Validate queue name
  if (!queueName || !queueName.trim()) {
    return { error: 'Queue name is required' }
  }

  // Build queue options
  const options: Record<string, unknown> = {}

  if (policy && policy !== 'standard') {
    options.policy = policy
  }

  if (partition) {
    options.partition = true
  }

  if (deadLetter && deadLetter.trim()) {
    options.deadLetter = deadLetter.trim()
  }

  if (warningQueueSize && warningQueueSize.trim()) {
    const num = Number(warningQueueSize)
    if (!Number.isInteger(num) || num <= 0) {
      return { error: 'Warning queue size must be a positive integer' }
    }
    options.warningQueueSize = num
  }

  if (retryLimit && retryLimit.trim()) {
    const num = Number(retryLimit)
    if (!Number.isInteger(num) || num < 0) {
      return { error: 'Retry limit must be a non-negative integer' }
    }
    options.retryLimit = num
  }

  if (retryDelay && retryDelay.trim()) {
    const num = Number(retryDelay)
    if (!Number.isInteger(num) || num < 0) {
      return { error: 'Retry delay must be a non-negative integer' }
    }
    options.retryDelay = num
  }

  if (retryBackoff) {
    options.retryBackoff = true
  }

  if (retryDelayMax && retryDelayMax.trim()) {
    const num = Number(retryDelayMax)
    if (!Number.isInteger(num) || num <= 0) {
      return { error: 'Retry delay max must be a positive integer' }
    }
    options.retryDelayMax = num
  }

  if (expireInSeconds && expireInSeconds.trim()) {
    const num = Number(expireInSeconds)
    if (!Number.isInteger(num) || num <= 0) {
      return { error: 'Expire in seconds must be a positive integer' }
    }
    options.expireInSeconds = num
  }

  if (retentionSeconds && retentionSeconds.trim()) {
    const num = Number(retentionSeconds)
    if (!Number.isInteger(num) || num <= 0) {
      return { error: 'Retention seconds must be a positive integer' }
    }
    options.retentionSeconds = num
  }

  if (deleteAfterSeconds && deleteAfterSeconds.trim()) {
    const num = Number(deleteAfterSeconds)
    if (!Number.isInteger(num) || num < 0) {
      return { error: 'Delete after seconds must be a non-negative integer (0 = never delete)' }
    }
    options.deleteAfterSeconds = num
  }

  try {
    await createQueue(
      context.DB_URL,
      context.SCHEMA,
      queueName.trim(),
      Object.keys(options).length > 0 ? options : undefined
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { error: `Failed to create queue: ${message}` }
  }

  // Preserve db param on redirect
  const url = new URL(request.url)
  const dbParam = url.searchParams.get('db')
  const redirectUrl = dbParam
    ? `/queues/${encodeURIComponent(queueName.trim())}?db=${encodeURIComponent(dbParam)}`
    : `/queues/${encodeURIComponent(queueName.trim())}`

  return redirect(redirectUrl)
}

export function ErrorBoundary () {
  return (
    <ErrorCard
      title="Failed to load queue creation page"
      backTo={{ href: '/queues', label: 'Back to Queues' }}
    />
  )
}

export default function CreateQueue ({ loaderData }: Route.ComponentProps) {
  const { queues } = loaderData
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const isSubmitting = navigation.state === 'submitting'
  const [isDirty, setIsDirty] = useState(false)

  // Policy select state
  const [policy, setPolicy] = useState('standard')

  // Storage select state
  const [storage, setStorage] = useState('shared')

  // Retry backoff state
  const [retryBackoff, setRetryBackoff] = useState(false)

  // Dead letter queue autocomplete state
  const [deadLetterSearch, setDeadLetterSearch] = useState('')
  const [selectedDeadLetter, setSelectedDeadLetter] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)

  const filteredQueues = queues.filter((q: any) =>
    q.name.toLowerCase().includes(deadLetterSearch.toLowerCase())
  )

  const handleDeadLetterSelect = (queueName: string) => {
    setSelectedDeadLetter(queueName)
    setDeadLetterSearch(queueName)
    setShowDropdown(false)
    setIsDirty(true)
  }

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty &&
      !isSubmitting &&
      currentLocation.pathname !== nextLocation.pathname
  )

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty && !isSubmitting) {
        e.preventDefault()
        e.returnValue = ''
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty, isSubmitting])

  return (
    <div className="space-y-6">
      {blocker.state === 'blocked' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-lg p-6 max-w-md mx-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Unsaved Changes
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              You have unsaved changes. Are you sure you want to leave this page?
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => blocker.reset()}
              >
                Stay
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => blocker.proceed()}
              >
                Leave
              </Button>
            </div>
          </div>
        </div>
      )}

      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
        Create Queue
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>Queue Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            className="space-y-5"
            onChange={() => setIsDirty(true)}
            onSubmit={() => setIsDirty(false)}
          >
            {actionData && 'error' in actionData && (
              <div className={cn(
                'rounded-lg border px-4 py-3 text-sm',
                'bg-red-50 border-red-200 text-red-700',
                'dark:bg-red-950 dark:border-red-800 dark:text-red-400'
              )}>
                {actionData.error}
              </div>
            )}

            <div>
              <label htmlFor="queueName" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Queue Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id="queueName"
                name="queueName"
                required
                placeholder="my-queue"
                className={cn(
                  'w-full rounded-lg border px-3 py-2 text-sm',
                  'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                  'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                  'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                )}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="policy" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Policy
                </label>
                <Select
                  value={policy}
                  onValueChange={(value) => {
                    setPolicy(value)
                    setIsDirty(true)
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="short">Short</SelectItem>
                    <SelectItem value="singleton">Singleton</SelectItem>
                    <SelectItem value="stately">Stately</SelectItem>
                    <SelectItem value="exclusive">Exclusive</SelectItem>
                  </SelectContent>
                </Select>
                <input type="hidden" name="policy" value={policy} />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Standard supports all features. Other policies restrict job queuing behavior.
                </p>
              </div>

              <div>
                <label htmlFor="storage" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Storage
                </label>
                <Select
                  value={storage}
                  onValueChange={(value) => {
                    setStorage(value)
                    setIsDirty(true)
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="shared">Shared</SelectItem>
                    <SelectItem value="partitioned">Partitioned</SelectItem>
                  </SelectContent>
                </Select>
                <input type="hidden" name="partition" value={storage === 'partitioned' ? 'true' : 'false'} />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Partitioned creates a dedicated table for this queue
                </p>
              </div>

              <div>
                <label htmlFor="deadLetterSearch" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Dead Letter Queue
                </label>
                <div className="relative">
                  <input
                    type="text"
                    id="deadLetterSearch"
                    value={deadLetterSearch}
                    onChange={(e) => {
                      setDeadLetterSearch(e.target.value)
                      setShowDropdown(true)
                    }}
                    onFocus={() => setShowDropdown(true)}
                    onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
                    placeholder="Search for a queue..."
                    autoComplete="off"
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-sm',
                      'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                      'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                      'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                    )}
                  />
                  <input type="hidden" name="deadLetter" value={selectedDeadLetter} />

                  {showDropdown && filteredQueues.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md shadow-lg max-h-60 overflow-auto">
                      {filteredQueues.map((queue: any) => (
                        <button
                          key={queue.name}
                          type="button"
                          onClick={() => handleDeadLetterSelect(queue.name)}
                          className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100 cursor-pointer text-sm"
                        >
                          {queue.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {selectedDeadLetter && (
                  <p className="mt-1 text-xs text-green-600 dark:text-green-400">
                    Selected: {selectedDeadLetter}
                  </p>
                )}
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Failed jobs will be moved to this queue after all retries
                </p>
              </div>

              <div>
                <label htmlFor="warningQueueSize" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Warning Queue Size
                </label>
                <input
                  type="number"
                  id="warningQueueSize"
                  name="warningQueueSize"
                  min="1"
                  placeholder="Optional"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Emit warning when queue size exceeds this value
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="retryLimit" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Retry Limit
                </label>
                <input
                  type="number"
                  id="retryLimit"
                  name="retryLimit"
                  min="0"
                  placeholder="2"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
              </div>

              <div>
                <label htmlFor="retryDelay" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Retry Delay (seconds)
                </label>
                <input
                  type="number"
                  id="retryDelay"
                  name="retryDelay"
                  min="0"
                  placeholder="0"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Retry Backoff
                </label>
                <div className="py-2 pb-6">
                  <Checkbox
                    id="retryBackoff"
                    name="retryBackoff"
                    value="true"
                    checked={retryBackoff}
                    onChange={(e) => {
                      setRetryBackoff(e.target.checked)
                      setIsDirty(true)
                    }}
                    label="Enable Exponential Backoff"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="retryDelayMax" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Max Retry Delay (seconds)
                </label>
                <input
                  type="number"
                  id="retryDelayMax"
                  name="retryDelayMax"
                  min="1"
                  placeholder="No limit"
                  disabled={!retryBackoff}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Only used with exponential backoff
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="expireInSeconds" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Expire In Seconds
                </label>
                <input
                  type="number"
                  id="expireInSeconds"
                  name="expireInSeconds"
                  min="1"
                  placeholder="900"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Default: 15 minutes (900 seconds)
                </p>
              </div>

              <div>
                <label htmlFor="retentionSeconds" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Retention Seconds
                </label>
                <input
                  type="number"
                  id="retentionSeconds"
                  name="retentionSeconds"
                  min="1"
                  placeholder="1209600"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Default: 14 days (1209600 seconds)
                </p>
              </div>

              <div>
                <label htmlFor="deleteAfterSeconds" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Delete After Seconds
                </label>
                <input
                  type="number"
                  id="deleteAfterSeconds"
                  name="deleteAfterSeconds"
                  min="0"
                  placeholder="604800"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Default: 7 days (604800 seconds). Set to 0 to never delete.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Creating...' : 'Create Queue'}
              </Button>
              <DbLink
                to="/queues"
                className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              >
                Cancel
              </DbLink>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
