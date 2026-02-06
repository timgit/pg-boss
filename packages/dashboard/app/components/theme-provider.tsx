import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'

export type ColorTheme = 'emerald' | 'teal' | 'cyan' | 'sky' | 'blue' | 'indigo' | 'violet' | 'purple'

// Ordered by hue (warm to cool to warm)
export const COLOR_THEMES: ColorTheme[] = [
  'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple'
]

// Tailwind color-600 hex values for favicon
const COLOR_HEX: Record<ColorTheme, string> = {
  emerald: '#059669',
  teal: '#0d9488',
  cyan: '#0891b2',
  sky: '#0284c7',
  blue: '#2563eb',
  indigo: '#4f46e5',
  violet: '#7c3aed',
  purple: '#9333ea',
}

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
  return 'violet'
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

    // Update favicon with new color
    const hex = COLOR_HEX[colorTheme]
    const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${hex}"/><text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="bold" fill="white">PG</text></svg>`
    const encodedSvg = encodeURIComponent(faviconSvg)

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link) {
      link.href = `data:image/svg+xml,${encodedSvg}`
    } else {
      link = document.createElement('link')
      link.rel = 'icon'
      link.type = 'image/svg+xml'
      link.href = `data:image/svg+xml,${encodedSvg}`
      document.head.appendChild(link)
    }
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
