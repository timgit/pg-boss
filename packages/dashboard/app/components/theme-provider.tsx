import { createContext, useContext, useEffect, useState } from 'react'
import { applyFavicon, faviconDataUri } from '~/lib/favicon'

type Theme = 'light' | 'dark' | 'system'

export type ColorTheme = 'cobalt' | 'emerald' | 'teal' | 'cyan' | 'sky' | 'blue' | 'indigo' | 'violet' | 'purple'

// Cobalt is the console's signature primary; the rest follow by hue.
export const COLOR_THEMES: ColorTheme[] = [
  'cobalt', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple'
]

// Color-600 hex values for favicon

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  resolvedTheme: 'light' | 'dark'
  colorTheme: ColorTheme
  setColorTheme: (colorTheme: ColorTheme) => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

const STORAGE_KEY = 'pg-boss-theme'
const COLOR_STORAGE_KEY = 'pg-boss-color-theme'

function getSystemTheme (): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getStoredTheme (): Theme {
  if (typeof window === 'undefined') return 'system'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored
  }
  return 'system'
}

function getStoredColorTheme (): ColorTheme {
  if (typeof window === 'undefined') return 'violet'
  const stored = localStorage.getItem(COLOR_STORAGE_KEY)
  if (stored && COLOR_THEMES.includes(stored as ColorTheme)) {
    return stored as ColorTheme
  }
  return 'cobalt'
}

export function ThemeProvider ({ children }: { children: React.ReactNode }) {
  // Use lazy initializers to read from localStorage on first client render
  const [theme, setThemeState] = useState<Theme>(getStoredTheme)
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    const stored = getStoredTheme()
    return stored === 'system' ? getSystemTheme() : stored
  })
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(getStoredColorTheme)

  // Update resolved theme when theme changes
  useEffect(() => {
    const resolved = theme === 'system' ? getSystemTheme() : theme
    setResolvedTheme(resolved)

    // Update document class
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(resolved)
    // Keep the selected mode in sync so the CSS-driven sidebar label updates
    // when the theme changes without a reload.
    root.dataset.themeMode = theme
  }, [theme])

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleChange = () => {
      if (theme === 'system') {
        const resolved = getSystemTheme()
        setResolvedTheme(resolved)
        document.documentElement.classList.remove('light', 'dark')
        document.documentElement.classList.add(resolved)
      }
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  // Sync color theme to document attribute and update favicon
  useEffect(() => {
    document.documentElement.dataset.colorTheme = colorTheme

    // One helper, shared with the inline script that runs before hydration, so
    // the icon cannot disagree with itself. This used to draw the old `PG`
    // monogram inline here, which survived the mark replacing it everywhere else.
    applyFavicon(faviconDataUri(colorTheme))

  }, [colorTheme])

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme)
    localStorage.setItem(STORAGE_KEY, newTheme)
  }

  const setColorTheme = (newColorTheme: ColorTheme) => {
    setColorThemeState(newColorTheme)
    localStorage.setItem(COLOR_STORAGE_KEY, newColorTheme)
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme, colorTheme, setColorTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme () {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
