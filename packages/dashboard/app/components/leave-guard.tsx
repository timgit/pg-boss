import { useEffect } from 'react'
import { useBlocker } from 'react-router'
import { Button } from '~/components/ui/button'

/**
 * Asks before a navigation or a reload throws away a form that has been typed in. `unsaved` names
 * what would be lost, as in "The job hasn't been sent."
 */
export function LeaveGuard ({ dirty, unsaved }: { dirty: boolean, unsaved: string }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname)

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  if (blocker.state !== 'blocked') return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div role="dialog" aria-labelledby="leave-title" className="mx-4 max-w-md rounded-lg bg-[var(--surface-card)] p-6 shadow-lg">
        <h2 id="leave-title" className="mb-2 text-lg font-semibold text-[var(--text-primary)]">Unsaved changes</h2>
        <p className="mb-6 text-sm text-[var(--text-secondary)]">{unsaved} Leave this page anyway?</p>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" size="sm" onClick={() => blocker.reset()}>Stay</Button>
          <Button type="button" variant="danger" size="sm" onClick={() => blocker.proceed()}>Leave</Button>
        </div>
      </div>
    </div>
  )
}
