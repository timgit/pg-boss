import { useState, useEffect } from 'react'
import { redirect, useActionData, useNavigation, useBlocker } from 'react-router'
import { DbLink } from '~/components/db-link'
import { schedule } from '~/lib/boss.server'
import { getQueues } from '~/lib/queries.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { ErrorCard } from '~/components/error-card'
import { cn } from '~/lib/utils'

export async function loader ({ context }: any) {
  const queues = await getQueues(context.DB_URL, context.SCHEMA)
  return { queues }
}

export async function action ({ request, context }: any) {
  const formData = await request.formData()

  const name = formData.get('name') as string | null
  const cron = formData.get('cron') as string | null
  const timezone = formData.get('timezone') as string | null
  const key = formData.get('key') as string | null
  const dataStr = formData.get('data') as string | null
  const priority = formData.get('priority') as string | null
  const retryLimit = formData.get('retryLimit') as string | null
  const expireInSeconds = formData.get('expireInSeconds') as string | null

  // Validate required fields
  if (!name || !name.trim()) {
    return { error: 'Queue name is required' }
  }

  if (!cron || !cron.trim()) {
    return { error: 'Cron expression is required' }
  }

  // Validate cron format (basic validation)
  const cronParts = cron.trim().split(/\s+/)
  if (cronParts.length !== 5) {
    return { error: 'Cron expression must have 5 parts (minute hour day month weekday)' }
  }

  // Validate JSON data if provided
  let parsedData: object | undefined
  if (dataStr && dataStr.trim()) {
    try {
      parsedData = JSON.parse(dataStr)
    } catch {
      return { error: 'Invalid JSON in data payload' }
    }

    if (typeof parsedData !== 'object' || parsedData === null || Array.isArray(parsedData)) {
      return { error: 'Data payload must be a JSON object' }
    }
  }

  // Build schedule options
  const options: Record<string, unknown> = {}

  if (timezone && timezone.trim()) {
    options.tz = timezone.trim()
  }

  if (key && key.trim()) {
    options.key = key.trim()
  }

  if (priority && priority.trim()) {
    const num = Number(priority)
    if (!Number.isInteger(num)) {
      return { error: 'Priority must be an integer' }
    }
    options.priority = num
  }

  if (retryLimit && retryLimit.trim()) {
    const num = Number(retryLimit)
    if (!Number.isInteger(num) || num < 0) {
      return { error: 'Retry limit must be a non-negative integer' }
    }
    options.retryLimit = num
  }

  if (expireInSeconds && expireInSeconds.trim()) {
    const num = Number(expireInSeconds)
    if (!Number.isInteger(num) || num <= 0) {
      return { error: 'Expire in seconds must be a positive integer' }
    }
    options.expireInSeconds = num
  }

  try {
    await schedule(
      context.DB_URL,
      context.SCHEMA,
      name.trim(),
      cron.trim(),
      parsedData,
      Object.keys(options).length > 0 ? options : undefined
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { error: `Failed to schedule job: ${message}` }
  }

  // Preserve db param on redirect
  const url = new URL(request.url)
  const dbParam = url.searchParams.get('db')
  const redirectUrl = dbParam
    ? `/schedules?db=${encodeURIComponent(dbParam)}`
    : `/schedules`

  return redirect(redirectUrl)
}

export function ErrorBoundary () {
  return (
    <ErrorCard
      title="Failed to load schedule creation"
      backTo={{ href: '/schedules', label: 'Back to Schedules' }}
    />
  )
}

export default function CreateSchedule ({ loaderData, actionData }: any) {
  const actionDataResult = useActionData<typeof action>()
  const navigation = useNavigation()
  const isSubmitting = navigation.state === 'submitting'

  const { queues } = loaderData
  const [queueSearch, setQueueSearch] = useState('')
  const [selectedQueue, setSelectedQueue] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [isDirty, setIsDirty] = useState(false)

  const filteredQueues = queues.filter((q: any) =>
    q.name.toLowerCase().includes(queueSearch.toLowerCase())
  )

  const handleQueueSelect = (queueName: string) => {
    setSelectedQueue(queueName)
    setQueueSearch(queueName)
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

      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <DbLink to="/schedules" className="hover:text-gray-700 dark:hover:text-gray-300">
          Schedules
        </DbLink>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100 font-medium">Schedule Job</span>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Schedule Job</h1>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="post" className="space-y-5" onChange={() => setIsDirty(true)}>
            {actionDataResult && 'error' in actionDataResult && (
              <div className={cn(
                'rounded-lg border px-4 py-3 text-sm',
                'bg-red-50 border-red-200 text-red-700',
                'dark:bg-red-950 dark:border-red-800 dark:text-red-400'
              )}>
                {actionDataResult.error}
              </div>
            )}

            {/* Row 1: Queue Name and Schedule Key */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Queue Name <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    id="queueSearch"
                    value={queueSearch}
                    onChange={(e) => {
                      setQueueSearch(e.target.value)
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
                  <input type="hidden" name="name" value={selectedQueue} required />

                  {showDropdown && filteredQueues.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md shadow-lg max-h-60 overflow-auto">
                      {filteredQueues.map((queue: any) => (
                        <button
                          key={queue.name}
                          type="button"
                          onClick={() => handleQueueSelect(queue.name)}
                          className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100 cursor-pointer text-sm"
                        >
                          {queue.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {selectedQueue && (
                  <p className="mt-1 text-xs text-green-600 dark:text-green-400">
                    Selected: {selectedQueue}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="key" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Schedule Key
                </label>
                <input
                  type="text"
                  id="key"
                  name="key"
                  placeholder="Optional unique key"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
              </div>
            </div>

            {/* Row 2: Cron Expression and Timezone */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="cron" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Cron Expression <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  id="cron"
                  name="cron"
                  required
                  placeholder="0 8 * * *"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm font-mono',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Format: minute hour day month weekday
                </p>
              </div>

              <div>
                <label htmlFor="timezone" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Timezone
                </label>
                <input
                  type="text"
                  id="timezone"
                  name="timezone"
                  placeholder="UTC"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Optional: IANA timezone (e.g. UTC, America/New_York)
                </p>
              </div>
            </div>

            <div>
              <label htmlFor="data" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Data 
              </label>
              <textarea
                id="data"
                name="data"
                rows={4}
                placeholder='{"key": "value"}'
                className={cn(
                  'w-full rounded-lg border px-3 py-2 text-sm font-mono',
                  'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                  'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                  'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                )}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Optional: JSON object to pass as job data
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="priority" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Priority
                </label>
                <input
                  type="number"
                  id="priority"
                  name="priority"
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
                <label htmlFor="retryLimit" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Retry Limit
                </label>
                <input
                  type="number"
                  id="retryLimit"
                  name="retryLimit"
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
                <label htmlFor="expireInSeconds" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Expire In Seconds
                </label>
                <input
                  type="number"
                  id="expireInSeconds"
                  name="expireInSeconds"
                  min="1"
                  placeholder="Default"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Creating...' : 'Schedule Job'}
              </Button>
              <DbLink
                to="/schedules"
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