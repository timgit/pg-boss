import { useMatches, useLocation } from 'react-router'
import { DbLink } from './db-link'

export function Breadcrumbs() {
  const matches = useMatches()
  const location = useLocation()

  // Build breadcrumb items based on current path
  const pathSegments = location.pathname.split('/').filter(Boolean)

  if (pathSegments.length === 0) {
    return null
  }

  const breadcrumbs: Array<{ label: string; href?: string }> = []

  // Handle different route patterns
  if (pathSegments[0] === 'queues') {
    breadcrumbs.push({ label: 'Queues', href: '/queues' })

    if (pathSegments.length > 1 && pathSegments[1] !== 'queues') {
      const queueName = decodeURIComponent(pathSegments[1])
      breadcrumbs.push({ label: queueName, href: `/queues/${encodeURIComponent(queueName)}` })

      if (pathSegments.length > 2 && pathSegments[2] === 'jobs' && pathSegments[3]) {
        const jobId = pathSegments[3]
        breadcrumbs.push({ label: `${jobId.slice(0, 8)}...` })
      }
    }
  } else if (pathSegments[0] === 'schedules') {
    breadcrumbs.push({ label: 'Schedules', href: '/schedules' })

    if (pathSegments.length === 1 || pathSegments[1] === 'new') {
      if (pathSegments[1] === 'new') {
        breadcrumbs.push({ label: 'Schedule Job' })
      }
    } else if (pathSegments.length > 1) {
      const scheduleName = decodeURIComponent(pathSegments[1])
      breadcrumbs.push({ label: scheduleName })
    }
  } else if (pathSegments[0] === 'jobs') {
    breadcrumbs.push({ label: 'Jobs' })
  } else if (pathSegments[0] === 'warnings') {
    breadcrumbs.push({ label: 'Warnings' })
  } else if (pathSegments[0] === 'send') {
    breadcrumbs.push({ label: 'Queues', href: '/queues' })
    breadcrumbs.push({ label: 'Send Job' })
  }

  if (breadcrumbs.length === 0) {
    return null
  }

  return (
    <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1

        return (
          <div key={index} className="flex items-center gap-2">
            {index > 0 && <span>/</span>}
            {crumb.href && !isLast ? (
              <DbLink to={crumb.href} className="hover:text-gray-700 dark:hover:text-gray-300">
                {crumb.label}
              </DbLink>
            ) : (
              <span className={isLast ? "text-gray-900 dark:text-gray-100 font-medium" : ""}>
                {crumb.label}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
