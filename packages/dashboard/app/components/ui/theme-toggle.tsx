import { Moon, Sun, Monitor } from 'lucide-react'
import { Menu } from '@base-ui/react/menu'
import { useTheme } from '~/components/theme-provider'
import { cn } from '~/lib/utils'

const themeLabels = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

export function ThemeToggle () {
  const { theme, setTheme, resolvedTheme } = useTheme()

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          'flex items-center gap-2 rounded-md p-2 w-full cursor-pointer',
          'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent',
          'focus:outline-none',
          'transition-colors'
        )}
        aria-label="Toggle theme"
      >
        {resolvedTheme === 'dark' ? (
          <Moon className="h-5 w-5 shrink-0" />
        ) : (
          <Sun className="h-5 w-5 shrink-0" />
        )}
        <span className="text-sm group-data-[state=collapsed]:hidden">{themeLabels[theme]}</span>
      </Menu.Trigger>

      <Menu.Portal container={typeof document !== 'undefined' ? document.body : undefined}>
        <Menu.Positioner className="z-[100]">
          <Menu.Popup
            className={cn(
              'min-w-[8rem] rounded-md border p-1 shadow-md z-[100]',
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
