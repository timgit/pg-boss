import { useState, useEffect } from 'react'
import { redirect, useActionData, useNavigation, useBlocker } from 'react-router'
import { DbLink } from '~/components/db-link'
import type { Route } from './+types/queues.$name.send'
import { getQueue } from '~/lib/queries.server'
import { sendJob } from '~/lib/boss.server'
import { Card, CardHeader, CardTitle, CardContent } from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { ErrorCard } from '~/components/error-card'
import { cn } from '~/lib/utils'

export async function loader ({ params, context }: Route.LoaderArgs) {
  const queue = await getQueue(context.DB_URL, context.SCHEMA, params.name)

  if (!queue) {
    throw new Response('Queue not found', { status: 404 })
  }

  return { queueName: queue.name }
}

export async function action ({ params, request, context }: Route.ActionArgs) {
  const formData = await request.formData()

  const dataStr = formData.get('data') as string | null
  const priority = formData.get('priority') as string | null
  const startAfter = formData.get('startAfter') as string | null
  const singletonKey = formData.get('singletonKey') as string | null
  const retryLimit = formData.get('retryLimit') as string | null
  const expireInSeconds = formData.get('expireInSeconds') as string | null

  // Validate JSON data
  if (!dataStr || !dataStr.trim()) {
    return { error: 'Data payload is required' }
  }

  let parsedData: object
  try {
    parsedData = JSON.parse(dataStr)
  } catch {
    return { error: 'Invalid JSON in data payload' }
  }

  if (typeof parsedData !== 'object' || parsedData === null || Array.isArray(parsedData)) {
    return { error: 'Data payload must be a JSON object' }
  }

  // Build send options
  const options: Record<string, unknown> = {}

  if (priority && priority.trim()) {
    const num = Number(priority)
    if (!Number.isInteger(num)) {
      return { error: 'Priority must be an integer' }
    }
    options.priority = num
  }

  if (startAfter && startAfter.trim()) {
    options.startAfter = startAfter.trim()
  }

  if (singletonKey && singletonKey.trim()) {
    options.singletonKey = singletonKey.trim()
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
    await sendJob(
      context.DB_URL,
      context.SCHEMA,
      params.name,
      parsedData,
      Object.keys(options).length > 0 ? options : undefined
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { error: `Failed to send job: ${message}` }
  }

  // Preserve db param on redirect
  const url = new URL(request.url)
  const dbParam = url.searchParams.get('db')
  const redirectUrl = dbParam
    ? `/queues/${params.name}?db=${encodeURIComponent(dbParam)}`
    : `/queues/${params.name}`

  return redirect(redirectUrl)
}

export function ErrorBoundary () {
  return (
    <ErrorCard
      title="Failed to load queue"
      backTo={{ href: '/queues', label: 'Back to Queues' }}
    />
  )
}

export default function SendJob ({ loaderData }: Route.ComponentProps) {
  const { queueName } = loaderData
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const isSubmitting = navigation.state === 'submitting'
  const [isDirty, setIsDirty] = useState(false)

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
        <DbLink to="/queues" className="hover:text-gray-700 dark:hover:text-gray-300">
          Queues
        </DbLink>
        <span>/</span>
        <DbLink to={`/queues/${queueName}`} className="hover:text-gray-700 dark:hover:text-gray-300">
          {queueName}
        </DbLink>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100 font-medium">Send Job</span>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Send Job</h1>

      <Card>
        <CardHeader>
          <CardTitle>Job Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="post" className="space-y-5" onChange={() => setIsDirty(true)}>
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
              <label htmlFor="data" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Data <span className="text-red-500">*</span>
              </label>
              <textarea
                id="data"
                name="data"
                rows={6}
                required
                placeholder='{"key": "value"}'
                className={cn(
                  'w-full rounded-lg border px-3 py-2 text-sm font-mono',
                  'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                  'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                  'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                )}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                <label htmlFor="startAfter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Start After
                </label>
                <input
                  type="text"
                  id="startAfter"
                  name="startAfter"
                  placeholder="e.g. 2025-01-01T00:00:00Z or 5 minutes"
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-sm',
                    'bg-white border-gray-300 text-gray-900 placeholder-gray-400',
                    'dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100 dark:placeholder-gray-500',
                    'focus:outline-none focus:ring-2 focus:ring-primary-600 focus:border-transparent'
                  )}
                />
              </div>

              <div>
                <label htmlFor="singletonKey" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Singleton Key
                </label>
                <input
                  type="text"
                  id="singletonKey"
                  name="singletonKey"
                  placeholder="Optional unique key"
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
                {isSubmitting ? 'Sending...' : 'Send Job'}
              </Button>
              <DbLink
                to={`/queues/${queueName}`}
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
