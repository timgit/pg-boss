import { isRouteErrorResponse } from 'react-router'
import { DbLink } from './db-link'
import { Card, CardContent } from './ui/card'

interface ErrorCardProps {
  title: string
  message?: string
  /**
   * The boundary's error, forwarded from `ErrorBoundary({ error })`.
   *
   * When it is a thrown `Response` the server wrote an explanation worth showing —
   * a read-only refusal, or a "Queue not found" 404 — so it wins over the generic
   * copy below. Optional: a boundary with nothing better to say still renders fine.
   */
  error?: unknown
  backTo?: {
    href: string
    label: string
  }
}

export function ErrorCard ({
  title,
  message = 'Please check your database connection and try again.',
  error,
  backTo,
}: ErrorCardProps) {
  const response = isRouteErrorResponse(error) ? error : undefined
  const body = typeof response?.data === 'string' ? response.data.trim() : ''

  // A loader that simply threw has no server-authored text, so the caller's copy
  // stands. Only a real message displaces it.
  const heading = response?.statusText || title
  const detail = body || message

  return (
    <div className="p-6">
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-red-600 dark:text-red-400 font-medium">{heading}</p>
          <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">{detail}</p>
          {backTo && (
            <DbLink
              to={backTo.href}
              className="inline-block mt-4 text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
            >
              {backTo.label}
            </DbLink>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
