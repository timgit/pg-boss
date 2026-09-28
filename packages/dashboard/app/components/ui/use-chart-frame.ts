import { useEffect, useRef, useState, type RefObject } from 'react'

export type ResolvedColors<K extends string> = Record<K, string>

/**
 * CSS variables resolved to concrete colors, for canvas drawing, which can't read var(). Resolved
 * again when the theme class on <html> flips, so a chart follows light and dark like the rest of
 * the UI. Null until mounted: there is no computed style on the server.
 */
export function useCssColors<K extends string> (vars: Record<K, string>): ResolvedColors<K> | null {
  const [colors, setColors] = useState<ResolvedColors<K> | null>(null)
  const key = JSON.stringify(vars)

  useEffect(() => {
    const resolve = () => {
      const cs = getComputedStyle(document.documentElement)
      const out = {} as ResolvedColors<K>
      for (const [name, cssVar] of Object.entries(vars) as Array<[K, string]>) {
        out[name] = cs.getPropertyValue(cssVar).trim() || '#888888'
      }
      setColors(out)
    }
    resolve()
    const observer = new MutationObserver(resolve)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => observer.disconnect()
  }, [key])

  return colors
}

/** The width of an element, tracked as it resizes. `initial` until it has been measured. */
export function useElementWidth<T extends HTMLElement> (initial: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(initial)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width)
      if (w > 0) setWidth(w)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}
