interface QueryTimeoutBannerProps {
  timeoutMs: number
}

// Inline warning shown on the Jobs page when the list query was cancelled by
// statement_timeout. Deliberately not ErrorCard: the filter bar and chips stay
// interactive so the user can remove the expensive filter and retry.
export function QueryTimeoutBanner ({ timeoutMs }: QueryTimeoutBannerProps) {
  const seconds = Math.round(timeoutMs / 1000)
  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
    >
      <p className="font-medium">Query timed out</p>
      <p className="mt-1">
        This search exceeded the {seconds}s query limit and was cancelled.
        Try narrowing your filters — for example, select a specific queue or state — then retry.
      </p>
    </div>
  )
}
