import { useState, useEffect } from 'react'
import { useFetcher } from 'react-router'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import type { JobResult, JobState } from '~/lib/types'
import { formatDate, JOB_STATE_VARIANTS, cn } from '~/lib/utils'

interface JobDetailDialogProps {
  jobId: string
  jobState: JobState
}

export function JobDetailDialog ({ jobId, jobState }: JobDetailDialogProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const fetcher = useFetcher<{ job?: JobResult; error?: string }>()

  // Fetch job details when dialog opens
  useEffect(() => {
    if (isOpen && fetcher.state === 'idle' && !fetcher.data?.job) {
      fetcher.submit({ jobId, intent: 'view' }, { method: 'post' })
    }
  }, [isOpen, jobId, fetcher])

  const job = fetcher.data?.job
  const isLoading = fetcher.state !== 'idle'
  const error = fetcher.data?.error

  const copyId = async () => {
    await navigator.clipboard.writeText(jobId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <Button variant="ghost" size="sm" onClick={() => setIsOpen(true)}>
        View
      </Button>
      <DialogContent className="w-[42rem] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="p-6 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center justify-between">
            <DialogTitle>Job Details</DialogTitle>
            <Badge variant={JOB_STATE_VARIANTS[jobState]} size="sm">
              {jobState}
            </Badge>
          </div>
        </DialogHeader>

        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          {/* Job ID - always available */}
          <div>
            <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
              Job ID
            </label>
            <div className="flex items-center gap-2">
              <code className={cn(
                'flex-1 text-sm px-3 py-2 rounded border font-mono break-all',
                'bg-gray-50 border-gray-200',
                'dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100'
              )}>
                {jobId}
              </code>
              <Button variant="outline" size="sm" onClick={copyId}>
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </div>

          {isLoading && (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              Loading job details...
            </div>
          )}

          {error && (
            <div className="text-center py-8 text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          {job && (
            <>
              {/* Basic Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Priority
                  </label>
                  <p className="text-sm text-gray-900 dark:text-gray-100">{job.priority}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Retries
                  </label>
                  <p className="text-sm text-gray-900 dark:text-gray-100">
                    {job.retryCount} / {job.retryLimit}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Created
                  </label>
                  <p className="text-sm text-gray-900 dark:text-gray-100">
                    {formatDate(new Date(job.createdOn))}
                  </p>
                </div>
                {job.startedOn && (
                  <div>
                    <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                      Started
                    </label>
                    <p className="text-sm text-gray-900 dark:text-gray-100">
                      {formatDate(new Date(job.startedOn))}
                    </p>
                  </div>
                )}
                {job.completedOn && (
                  <div>
                    <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                      Completed
                    </label>
                    <p className="text-sm text-gray-900 dark:text-gray-100">
                      {formatDate(new Date(job.completedOn))}
                    </p>
                  </div>
                )}
                {job.singletonKey && (
                  <div>
                    <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                      Singleton Key
                    </label>
                    <p className="text-sm text-gray-900 dark:text-gray-100 font-mono">{job.singletonKey}</p>
                  </div>
                )}
                {job.groupId && (
                  <div>
                    <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                      Group ID
                    </label>
                    <p className="text-sm text-gray-900 dark:text-gray-100 font-mono">{job.groupId}</p>
                  </div>
                )}
                {job.groupTier && (
                  <div>
                    <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                      Group Tier
                    </label>
                    <p className="text-sm text-gray-900 dark:text-gray-100">{job.groupTier}</p>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Data
                </label>
                <pre className={cn(
                  'text-sm px-3 py-2 rounded border font-mono overflow-x-auto max-h-48',
                  'bg-gray-50 border-gray-200',
                  'dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100'
                )}>
                  {job.data ? JSON.stringify(job.data, null, 2) : 'null'}
                </pre>
              </div>

              {/* Job Output */}
              {job.output !== undefined && job.output !== null && (
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Output
                  </label>
                  <pre className={cn(
                    'text-sm px-3 py-2 rounded border font-mono overflow-x-auto max-h-48',
                    'bg-gray-50 border-gray-200',
                    'dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100'
                  )}>
                    {JSON.stringify(job.output, null, 2)}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-6 border-t border-gray-200 dark:border-gray-800 flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setIsOpen(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
