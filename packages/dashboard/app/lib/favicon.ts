import faviconSource from '~/assets/pg-boss-favicon.svg?raw'

/**
 * The favicon, tinted to the chosen colour theme.
 *
 * One place, because there were three. The inline theme script set it before
 * paint, `links()` published a static copy that hydration then rendered over the
 * top of, and `ThemeProvider` set it again on every colour change — still
 * drawing the old `PG` monogram, months after the mark replaced it. The visible
 * symptom was a flash of the right colour on reload followed by the wrong one:
 * the script won, then `<Links />` overwrote it.
 *
 * `links()` no longer carries an icon at all. It cannot: the theme lives in
 * `localStorage`, which the server rendering that tag has never seen, so
 * anything it emits is a guess that has to be corrected on the client — and
 * correcting it is what caused the flash. The script sets it before first paint
 * and `ThemeProvider` keeps it current, which covers both the reload and the
 * picker.
 */

export type ColorThemeName =
  | 'cobalt' | 'emerald' | 'teal' | 'cyan' | 'sky'
  | 'blue' | 'indigo' | 'violet' | 'purple'

/**
 * Shared with the inline theme script, which is a string and cannot import —
 * it interpolates this at build time instead, so the two cannot drift.
 */
export const COLOR_HEX: Record<ColorThemeName, string> = {
  cobalt: '#284fe0',
  emerald: '#059669',
  teal: '#0d9488',
  cyan: '#0891b2',
  sky: '#0284c7',
  blue: '#2563eb',
  indigo: '#4f46e5',
  violet: '#7c3aed',
  purple: '#9333ea',
}

/** The mark's own square fill, which is what gets swapped for the theme colour. */
export const BRAND_COBALT = '#284fe0'

export function faviconDataUri (colorTheme: string): string {
  const hex = COLOR_HEX[colorTheme as ColorThemeName] ?? BRAND_COBALT
  const svg = faviconSource.split(BRAND_COBALT).join(hex)

  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * Point the document's icon at a data URI, creating the tag if the page has
 * none. Used by the provider; the inline script does the same thing by hand
 * because it runs before any of this is loaded.
 */
export function applyFavicon (href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')

  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/svg+xml'
    document.head.appendChild(link)
  }

  link.href = href
}
