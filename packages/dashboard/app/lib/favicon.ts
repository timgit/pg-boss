import faviconSource from '~/assets/pg-boss-favicon.svg?raw'

/**
 * The favicon, tinted to the chosen colour theme.
 *
 * One place, because three of them wanted to set it: the inline theme script
 * before paint, `links()` as part of the document head, and `ThemeProvider` on
 * every colour change. Two writers are enough to produce a flash of the right
 * colour followed by the wrong one — the script wins, then `<Links />` renders
 * over the top of it.
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
 * The theme assumed when nothing is stored. Shared with the inline script, which
 * interpolates it, so the icon drawn before paint and the palette applied after
 * hydration start from the same answer.
 */
export const DEFAULT_COLOR_THEME: ColorThemeName = 'cobalt'

/**
 * Shared with the inline theme script, which is a string and cannot import —
 * it interpolates this at build time instead, so the two cannot drift.
 *
 * These have to equal what `--primary-600` resolves to in `app.css`, because the
 * favicon and the sidebar square are meant to be the same colour. Only `cobalt`
 * is a literal there; the other eight are `var(--color-<name>-600)` from
 * Tailwind, and Tailwind 4 restated its whole palette in OKLCH. The values below
 * are the sRGB of *that* palette — the older hexes are visibly different
 * (purple was `#9333ea`, Tailwind 4 renders `#9810fa`), so a copy taken from
 * memory or from a v3 cheatsheet puts the tab icon off from the sidebar on
 * eight of the nine themes.
 */
export const COLOR_HEX: Record<ColorThemeName, string> = {
  cobalt: '#284fe0',
  emerald: '#009966',
  teal: '#009689',
  cyan: '#0092b8',
  sky: '#0084d1',
  blue: '#155dfc',
  indigo: '#4f39f6',
  violet: '#7f22fe',
  purple: '#9810fa',
}

/** The mark's own square fill, which is what gets swapped for the theme colour. */
export const BRAND_COBALT = '#284fe0'

/**
 * The tint is a substring swap, so it fails by doing nothing.
 *
 * `split(BRAND_COBALT).join(hex)` is context-free and case-sensitive. Redraw the
 * mark and export it as `#284FE0`, or as `rgb(40 79 224)`, or move the fill onto
 * a parent `<g>`, and every one of those still produces a valid favicon — the
 * cobalt one, on every theme, for ever, with no error anywhere. The `??`
 * fallback below does not cover it: that is for an unknown theme *name*.
 *
 * So assert the shape the swap depends on, once, at module load. It is the
 * cheapest place to turn a silent wrong colour into a loud failure, and the
 * condition is exact — one occurrence, because two would mean the swap is also
 * hitting something that is not the square.
 */
const brandOccurrences = faviconSource.split(BRAND_COBALT).length - 1

if (brandOccurrences !== 1) {
  throw new Error(
    `pg-boss-favicon.svg must contain exactly one "${BRAND_COBALT}" for the theme ` +
    `tint to work, found ${brandOccurrences}. The swap is a literal substring ` +
    'match: keep the square\'s fill as that exact lowercase hex, or update ' +
    'BRAND_COBALT and the inline theme script in app/root.tsx together.'
  )
}

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
