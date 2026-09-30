import { ARRAY_CAST } from '../src/adapters/placeholders.ts'

// node-postgres encodes each bound value from its JS shape. Bun.SQL and PGlite encode it from the
// type Postgres infers for the parameter. The bind audit (bindAudit.ts) records both halves for every
// statement the suite sends through node-postgres; these rules say which pairs another driver
// cannot carry. One row per driver behaviour, so a new adapter adds a rule, not a suite.

export type ValueKind = 'null' | 'string' | 'number' | 'boolean' | 'bigint' | 'object' | 'array' | 'date' | 'buffer'

export interface BindFinding {
  rule: string
  param: number
  type: string
  kind: ValueKind
  fix: string
}

// Test SQL that breaks a rule on purpose (a negative control) carries this comment.
export const IGNORE_MARKER = '/* bind-audit: ignore */'

const JSON_TYPES = new Set(['json', 'jsonb'])

export function kindOf (value: unknown): ValueKind {
  if (value == null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'date'
  if (Buffer.isBuffer(value)) return 'buffer'

  const type = typeof value

  return type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint' ? type : 'object'
}

// The text following each occurrence of $N, which is where a cast such as `::uuid[]` sits.
function followingEach (text: string, param: number): string[] {
  const following: string[] = []
  const re = /\$(\d+)/g
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    if (Number(match[1]) === param) following.push(text.slice(re.lastIndex))
  }

  return following
}

export function checkBinds (text: string, types: readonly string[], kinds: readonly ValueKind[]): BindFinding[] {
  if (text.includes(IGNORE_MARKER)) return []

  const findings: BindFinding[] = []

  kinds.forEach((kind, index) => {
    const param = index + 1
    const type = types[index] ?? 'unknown'
    const json = JSON_TYPES.has(type)
    const found = (rule: string, fix: string) => findings.push({ rule, param, type, kind, fix })

    if (kind === 'string' && json) {
      found('string-to-json', 'Bun.SQL encodes the string a second time; cast through text: $N::text::jsonb')
    }

    if (kind === 'array' && json) {
      found('array-to-json', 'node-postgres sends a JS array as a Postgres array literal; bind JSON.stringify(value) behind $N::text::jsonb')
    }

    if (kind === 'object' && !json) {
      found('object-to-non-json', 'PGlite sends String(value), "[object Object]"; bind it to a json parameter')
    }

    if (kind === 'array' && !json && !followingEach(text, param).every(rest => ARRAY_CAST.test(rest))) {
      found('array-not-expanded', 'Bun.SQL cannot bind an array; cast every occurrence as $N::type[] so fromBunSql expands it')
    }
  })

  return findings
}
