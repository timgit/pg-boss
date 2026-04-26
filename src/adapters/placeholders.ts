/**
 * Parses a SQL string with PostgreSQL-style `$N` placeholders into the
 * literal segments between placeholders and the values in textual order.
 *
 * Handles repeated indexes (e.g. `$2` appearing twice) by duplicating the
 * value at each occurrence, so adapters that target positional `?`-style
 * binders or tagged-template SQL builders stay consistent with what
 * postgres would have produced from the original `$N` form.
 */
export function parsePlaceholders (text: string, values?: readonly unknown[]): {
  parts: string[]
  reordered: unknown[]
} {
  const parts: string[] = []
  const reordered: unknown[] = []
  // Local /g regex: stateful via lastIndex but never shared across calls.
  const re = /\$(\d+)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    parts.push(text.slice(lastIndex, match.index))
    reordered.push(values?.[Number(match[1]) - 1])
    lastIndex = re.lastIndex
  }
  parts.push(text.slice(lastIndex))
  return { parts, reordered }
}
