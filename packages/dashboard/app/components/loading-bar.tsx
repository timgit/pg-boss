import { useNavigation } from 'react-router'

/**
 * A top loading bar that shows during page navigations.
 * Uses React Router's useNavigation to detect loading state.
 */
export function LoadingBar () {
  const navigation = useNavigation()
  const isLoading = navigation.state === 'loading'

  if (!isLoading) {
    return null
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-50 h-1 bg-gray-200 dark:bg-gray-800">
      <div className="h-full bg-primary-600 dark:bg-primary-400 animate-loading-bar" />
    </div>
  )
}
