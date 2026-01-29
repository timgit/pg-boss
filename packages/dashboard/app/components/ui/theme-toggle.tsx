import { Moon, Sun, Monitor } from 'lucide-react'
import { Menu } from '@base-ui/react/menu'
import { useTheme } from '~/components/theme-provider'
import { cn } from '~/lib/utils'

export function ThemeToggle () {
  const { theme, setTheme, resolvedTheme } = useTheme()

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          'inline-flex items-center justify-center rounded-md p-2',
          'text-gray-500 hover:text-gray-900 hover:bg-gray-100',
          'dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800',
          'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2',
          'dark:focus:ring-offset-gray-900',
          'transition-colors'
        )}
        aria-label="Toggle theme"
      >
        {resolvedTheme === 'dark' ? (
          <Moon className="h-5 w-5" />
        ) : (
          <Sun className="h-5 w-5" />
        )}
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner>
          <Menu.Popup
            className={cn(
              'min-w-[8rem] rounded-md border p-1 shadow-md',
              'bg-white border-gray-200',
              'dark:bg-gray-900 dark:border-gray-800',
              'animate-in fade-in-0 zoom-in-95'
            )}
          >
            <Menu.Item
              className={cn(
                'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer',
                'outline-none transition-colors',
                'text-gray-700 data-highlighted:bg-gray-100',
                'dark:text-gray-300 dark:data-highlighted:bg-gray-800',
                theme === 'light' && 'bg-gray-100 dark:bg-gray-800'
              )}
              onClick={() => setTheme('light')}
            >
              <Sun className="h-4 w-4" />
              Light
            </Menu.Item>

            <Menu.Item
              className={cn(
                'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer',
                'outline-none transition-colors',
                'text-gray-700 data-highlighted:bg-gray-100',
                'dark:text-gray-300 dark:data-highlighted:bg-gray-800',
                theme === 'dark' && 'bg-gray-100 dark:bg-gray-800'
              )}
              onClick={() => setTheme('dark')}
            >
              <Moon className="h-4 w-4" />
              Dark
            </Menu.Item>

            <Menu.Item
              className={cn(
                'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer',
                'outline-none transition-colors',
                'text-gray-700 data-highlighted:bg-gray-100',
                'dark:text-gray-300 dark:data-highlighted:bg-gray-800',
                theme === 'system' && 'bg-gray-100 dark:bg-gray-800'
              )}
              onClick={() => setTheme('system')}
            >
              <Monitor className="h-4 w-4" />
              System
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
