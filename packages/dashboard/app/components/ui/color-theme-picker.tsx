import { Menu } from '@base-ui/react/menu'
import { useTheme, COLOR_THEMES, type ColorTheme } from '~/components/theme-provider'
import { cn } from '~/lib/utils'

// Map color names to their Tailwind CSS variable for the 500 shade
const colorSwatchStyles: Record<ColorTheme, string> = {
  emerald: 'bg-emerald-500',
  teal: 'bg-teal-500',
  cyan: 'bg-cyan-500',
  sky: 'bg-sky-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  purple: 'bg-purple-500',
}

const colorLabels: Record<ColorTheme, string> = {
  emerald: 'Emerald',
  teal: 'Teal',
  cyan: 'Cyan',
  sky: 'Sky',
  blue: 'Blue',
  indigo: 'Indigo',
  violet: 'Violet',
  purple: 'Purple',
}

export function ColorThemePicker () {
  const { colorTheme, setColorTheme } = useTheme()

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          'flex items-center gap-2 rounded-md p-2 w-full cursor-pointer',
          'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent',
          'focus:outline-none',
          'transition-colors'
        )}
        aria-label="Change color theme"
      >
        <span className={cn('h-5 w-5 rounded-full shrink-0', colorSwatchStyles[colorTheme])} />
        <span className="text-sm group-data-[state=collapsed]:hidden">{colorLabels[colorTheme]}</span>
      </Menu.Trigger>

      <Menu.Portal container={typeof document !== 'undefined' ? document.body : undefined}>
        <Menu.Positioner className="z-[100]">
          <Menu.Popup
            className={cn(
              'rounded-md border p-2 shadow-md z-[100]',
              'bg-white border-gray-200',
              'dark:bg-gray-900 dark:border-gray-800',
              'animate-in fade-in-0 zoom-in-95'
            )}
          >
            <div className="grid grid-cols-4 gap-1.5">
              {COLOR_THEMES.map((color) => (
                <Menu.Item
                  key={color}
                  className={cn(
                    'w-7 h-7 rounded-full cursor-pointer transition-all',
                    'outline-none',
                    'hover:scale-110',
                    colorSwatchStyles[color],
                    colorTheme === color && 'ring-2 ring-offset-2 ring-gray-900 dark:ring-white dark:ring-offset-gray-900'
                  )}
                  onClick={() => setColorTheme(color)}
                  aria-label={color}
                  title={colorLabels[color]}
                />
              ))}
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
