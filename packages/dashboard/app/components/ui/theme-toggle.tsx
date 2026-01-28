import { Moon, Sun, Monitor } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useTheme } from '~/components/theme-provider'
import { cn } from '~/lib/utils'

export function ThemeToggle () {
  const { theme, setTheme, resolvedTheme } = useTheme()

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
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
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={cn(
            'min-w-[8rem] rounded-md border p-1 shadow-md',
            'bg-white border-gray-200',
            'dark:bg-gray-900 dark:border-gray-800',
            'animate-in fade-in-0 zoom-in-95'
          )}
          align="end"
          sideOffset={5}
        >
          <DropdownMenu.Item
            className={cn(
              'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer',
              'outline-none transition-colors',
              'text-gray-700 hover:bg-gray-100 focus:bg-gray-100',
              'dark:text-gray-300 dark:hover:bg-gray-800 dark:focus:bg-gray-800',
              theme === 'light' && 'bg-gray-100 dark:bg-gray-800'
            )}
            onSelect={() => setTheme('light')}
          >
            <Sun className="h-4 w-4" />
            Light
          </DropdownMenu.Item>

          <DropdownMenu.Item
            className={cn(
              'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer',
              'outline-none transition-colors',
              'text-gray-700 hover:bg-gray-100 focus:bg-gray-100',
              'dark:text-gray-300 dark:hover:bg-gray-800 dark:focus:bg-gray-800',
              theme === 'dark' && 'bg-gray-100 dark:bg-gray-800'
            )}
            onSelect={() => setTheme('dark')}
          >
            <Moon className="h-4 w-4" />
            Dark
          </DropdownMenu.Item>

          <DropdownMenu.Item
            className={cn(
              'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer',
              'outline-none transition-colors',
              'text-gray-700 hover:bg-gray-100 focus:bg-gray-100',
              'dark:text-gray-300 dark:hover:bg-gray-800 dark:focus:bg-gray-800',
              theme === 'system' && 'bg-gray-100 dark:bg-gray-800'
            )}
            onSelect={() => setTheme('system')}
          >
            <Monitor className="h-4 w-4" />
            System
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
