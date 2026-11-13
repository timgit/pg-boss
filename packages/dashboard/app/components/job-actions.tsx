import { useFetcher } from 'react-router'
import { Ban, Play, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { ConfirmDialog } from '~/components/ui/confirm-dialog'
import { jobVerbs, type JobActionResult } from '~/lib/job-actions'

/**
 * The job page's buttons: retry a failed job, resume a cancelled one, cancel one that hasn't
 * finished, and delete one that isn't running. Each posts to the job page's own action.
 */
export function JobActions ({ id, state }: { id: string, state: string }) {
  const fetcher = useFetcher<JobActionResult>()
  const busy = fetcher.state !== 'idle'
  const result = fetcher.data
  const { retry, resume, cancel, remove } = jobVerbs(state)

  if (!retry && !resume && !cancel && !remove) {
    return null
  }

  const submit = (intent: string) => fetcher.submit({ intent }, { method: 'post' })

  return (
    <>
      {result && !result.success && (
        <span role="status" className="max-w-xs text-xs text-[var(--state-retry-fg)]">
          {result.message}
        </span>
      )}
      {retry && (
        <Button variant="primary" size="md" disabled={busy} onClick={() => submit('retry')}>
          <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
          Retry job
        </Button>
      )}
      {resume && (
        <Button variant="primary" size="md" disabled={busy} onClick={() => submit('resume')}>
          <Play className="mr-2 h-4 w-4" aria-hidden="true" />
          Resume job
        </Button>
      )}
      {cancel && (
        <ConfirmDialog
          title="Cancel Job"
          description={`Are you sure you want to cancel job ${id}? This will prevent the job from being processed.`}
          confirmLabel="Cancel Job"
          confirmVariant="danger"
          triggerVariant="outline"
          trigger={<span className="inline-flex items-center gap-2"><Ban className="h-4 w-4" aria-hidden="true" />Cancel job</span>}
          onConfirm={() => submit('cancel')}
          disabled={busy}
        />
      )}
      {remove && (
        <ConfirmDialog
          title="Delete Job"
          description={`Are you sure you want to delete job ${id}? This action cannot be undone.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          triggerVariant="ghost"
          trigger={<span className="inline-flex items-center gap-2 text-[var(--state-failed-fg)]"><Trash2 className="h-4 w-4" aria-hidden="true" />Delete</span>}
          onConfirm={() => submit('delete')}
          disabled={busy}
        />
      )}
    </>
  )
}
