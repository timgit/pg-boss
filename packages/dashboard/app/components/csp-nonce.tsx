import { createContext, useContext } from 'react'

/** The request's script nonce during the server render, from `cspNonceContext`. */
export const CspNonce = createContext<string | undefined>(undefined)

let pageNonce: string | undefined

/**
 * The nonce the page was rendered with, or undefined when it has none. In the browser it comes
 * from a script the server wrote: the browser empties the attribute once it has checked the
 * script, and keeps the value in the `nonce` property, which hydration compares. Rendering the
 * same value keeps hydration quiet, and a script or stylesheet added on a later navigation is
 * allowed by the policy the page loaded with.
 */
export function useCspNonce (): string | undefined {
  const rendered = useContext(CspNonce)
  if (rendered !== undefined || typeof document === 'undefined') return rendered

  pageNonce ??= document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || undefined
  return pageNonce
}
