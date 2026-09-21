import { Moon, Sun } from 'lucide-react'
import { useTheme } from '~/components/theme-provider'
import { cn } from '~/lib/utils'

/**
 * Light or dark, in one click, from the topbar.
 *
 * It used to be a three-item menu — Light, Dark, System — in the sidebar
 * footer. Two of those three are the same decision made twice: somebody who
 * wants the console to follow the OS sets it once and never opens the menu
 * again, and everybody else is choosing between two states, which is a toggle
 * and not a menu. The `system` value still exists in the provider and is still
 * the default for a browser that has never chosen, so an install that follows
 * the OS keeps following it until somebody clicks this.
 *
 * `resolvedTheme` rather than `theme` decides what the click does, because
 * `system` is not a thing you can toggle away from without knowing what it
 * currently resolves to: from system-dark, this sets light, which is what
 * clicking a moon should do.
 *
 * Both icons render and CSS picks between them, which is the same contract the
 * menu trigger had. The `.dark` class is set by the inline script in `root.tsx`
 * before first paint, so the right icon is on screen in the first frame —
 * choosing in React would show the light icon until hydration and then swap it.
 */
export function ThemeToggle ({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      className={cn(
        'flex items-center justify-center rounded-md p-2 cursor-pointer',
        'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600',
        'transition-colors',
        className
      )}
      aria-label="Toggle theme"
    >
      <Sun className="h-5 w-5 shrink-0 dark:hidden" />
      <Moon className="hidden h-5 w-5 shrink-0 dark:block" />
    </button>
  )
}
