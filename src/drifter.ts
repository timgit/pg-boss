import { resolveSchemaName } from './tools.ts'
import type { ManagedIndex, InvalidIndex, MismatchedIndex, ManagedFunction, MismatchedFunction, TableColumnDrift, EnumDrift, ConstraintDrift, SchemaDriftReport } from './types.ts'

const SINGLE_QUOTE_REGEX = /'/g

// Extracts the first balanced parenthesised group from a CREATE INDEX statement — the key-column
// list. Stops at the matching close paren, so a trailing INCLUDE(...) or WHERE(...) is excluded and
// an inner COALESCE(...) is kept. Works on both hand-written DDL and pg_get_indexdef output (whose
// leading `USING btree (` opens the same first group). The INCLUDE payload is not ignored, just
// compared separately — see extractIndexIncludeList.
function extractIndexKeyList (ddl: string): string | null {
  const open = ddl.indexOf('(')
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < ddl.length; i++) {
    if (ddl[i] === '(') depth++
    else if (ddl[i] === ')' && --depth === 0) return ddl.slice(open + 1, i)
  }
  return null
}

// Strips SQL type casts, including schema-qualified enum casts (Postgres renders a job_state literal
// as `'active'::pgboss.job_state` and a text literal as `''::text`). Run before whitespace removal is
// fine — casts never contain spaces.
const CAST_REGEX = /::(?:[a-z_][a-z0-9_$]*\.)?[a-z_][a-z0-9_$]*(?:\[\])?/g

// Normalises a key-column list so an expected list and a pg_get_indexdef list compare equal when they
// mean the same thing: lower-cased, quotes and whitespace stripped, and type casts removed. Column
// ORDER is preserved — an index on (a, b) must not normalise equal to (b, a), which is exactly the
// index-ordinal significance the drift check needs. Parens are kept so COALESCE(...) survives.
function normalizeKeyList (keyList: string): string {
  return keyList
    .toLowerCase()
    .replace(/"/g, '')
    .replace(/\s+/g, '')
    .replace(CAST_REGEX, '')
}

export function indexKeys (ddl: string): string {
  const list = extractIndexKeyList(ddl)
  return list === null ? '' : normalizeKeyList(list)
}

// Extracts the INCLUDE(...) payload column list, or null when the index has none. Both hand-written
// DDL and pg_get_indexdef spell it the same way, and it always sits between the key list and the
// WHERE clause, so scanning from the end of the key list keeps an inner `INCLUDE` inside a quoted
// column name or a predicate literal out of reach.
function extractIndexIncludeList (ddl: string): string | null {
  const keyList = extractIndexKeyList(ddl)
  if (keyList === null) return null
  const afterKeys = ddl.indexOf('(') + keyList.length + 2
  const tail = ddl.slice(afterKeys)
  const m = tail.match(/^\s*INCLUDE\s*\(/i)
  if (!m) return null
  const open = afterKeys + m[0].length - 1
  let depth = 0
  for (let i = open; i < ddl.length; i++) {
    if (ddl[i] === '(') depth++
    else if (ddl[i] === ')' && --depth === 0) return ddl.slice(open + 1, i)
  }
  return null
}

// Normalises an INCLUDE list. Unlike the key list this is order-INSENSITIVE, and deliberately so:
// INCLUDE columns are payload, not part of the btree ordering, so `INCLUDE (a, b)` and
// `INCLUDE (b, a)` are the same index. Sorting them means a rebuild that lists them differently is
// not reported as drift, while a genuinely added or dropped payload column still is.
function normalizeIncludeList (includeList: string): string {
  return normalizeKeyList(includeList).split(',').filter(Boolean).sort().join(',')
}

export function indexInclude (ddl: string): string {
  const list = extractIndexIncludeList(ddl)
  return list === null ? '' : normalizeIncludeList(list)
}

// Readable INCLUDE column list for a drift report, '' when the index has no INCLUDE clause.
export function indexIncludeRaw (ddl: string): string {
  const list = extractIndexIncludeList(ddl)
  return list === null ? '' : list.replace(CAST_REGEX, '').replace(/\s+/g, ' ').trim()
}

// Everything after the top-level WHERE — the partial-index predicate — or '' for a non-partial index.
function extractPredicate (ddl: string): string {
  const m = ddl.match(/\bWHERE\b/i)
  return m ? ddl.slice(m.index! + m[0].length) : ''
}

// Normalises a predicate for comparison. Both sides originate from pg_get_indexdef — expected from the
// manifest, live from the catalog — so both carry pg's canonical form; this only undoes the cosmetic
// differences pg can vary between two equal predicates:
//   - casts added to every literal (`'active'::pgboss.job_state`, `'x'::text`) → stripped
//   - `IN (a, b)` rendered as `= ANY (ARRAY[a, b])` → folded back to `IN (a, b)`
//   - the redundant OUTER paren pair pg wraps the whole predicate in → removed
//   - case/whitespace differences → normalised away
// INNER grouping parens are deliberately KEPT: pg parenthesises each sub-expression identically for two
// equal predicates, so keeping them is symmetric, and it lets a real regrouping (`(a OR b) AND c` vs
// `a OR (b AND c)`) be detected as drift instead of both collapsing to the same token soup. This is why
// the whole-predicate paren strip must be OUTER-only (stripOuterParens), not a blanket paren removal.
function normalizePredicate (predicate: string): string {
  const folded = predicate
    .toLowerCase()
    .replace(/"/g, '')
    .replace(CAST_REGEX, '')
    .replace(/=\s*any\s*\(\s*array\s*\[([^\]]*)\]\s*\)/g, 'in ($1)')
  return stripOuterParens(folded).replace(/\s+/g, '')
}

export function indexPredicate (ddl: string): string {
  return normalizePredicate(extractPredicate(ddl))
}

// Readable (non-normalised) key-column list and predicate for a CREATE INDEX statement, with runs of
// whitespace collapsed to single spaces and type casts stripped (a live `'active'::pgboss.job_state`
// reads as `'active'`). These are the human-facing values surfaced in a drift report; the normalised
// forms above are only used for comparison. Returns '' when there is nothing to show (no key list /
// no WHERE).
export function indexKeysRaw (ddl: string): string {
  const list = extractIndexKeyList(ddl)
  return list === null ? '' : list.replace(CAST_REGEX, '').replace(/\s+/g, ' ').trim()
}

export function indexPredicateRaw (ddl: string): string {
  return stripOuterParens(extractPredicate(ddl).replace(CAST_REGEX, '').replace(/\s+/g, ' ').trim())
}

// True when the whole string is wrapped in a single outer parenthesis pair (the opening `(` matches
// the final `)`), e.g. "(a AND (b))" but not "(a) AND (b)".
function outerParensWrapWhole (s: string): boolean {
  if (s[0] !== '(') return false
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i === s.length - 1
  }
  return false
}

// Removes the redundant outer parentheses pg_get_indexdef wraps a whole predicate in. Only the
// outermost pair is stripped — inner grouping (which may be meaningful) is left intact.
function stripOuterParens (s: string): string {
  let out = s.trim()
  while (outerParensWrapWhole(out)) {
    out = out.slice(1, -1).trim()
  }
  return out
}

// Tidies a pg_get_indexdef statement for display: drops the `USING btree` clause (btree is the
// default access method and every pg-boss index uses it, so it is pure noise), strips type casts
// (`'active'::pgboss.job_state` reads as `'active'`), collapses whitespace, and removes the redundant
// outer parentheses around the WHERE predicate. Inner grouping is left as-is.
export function displayIndexDefinition (def: string): string {
  const cleaned = def.replace(/\s+USING\s+btree\s+/i, ' ').replace(CAST_REGEX, '').replace(/\s+/g, ' ').trim()
  const m = cleaned.match(/\bWHERE\b/i)
  if (!m) return cleaned
  const head = cleaned.slice(0, m.index! + m[0].length)
  const predicate = stripOuterParens(cleaned.slice(m.index! + m[0].length).trim())
  return `${head} ${predicate}`
}

// Extracts the body of a function definition — the text between the outer dollar-quote tags. Works on
// both pg-boss's own `CREATE FUNCTION ... AS $$ … $$` and Postgres's `pg_get_functiondef` output
// (which wraps the body in `$function$ … $function$`). Postgres stores prosrc verbatim, so the two
// bodies are byte-identical for an un-drifted function, modulo the dollar-quote tag name. Nested
// dollar quotes with a different tag (pg-boss uses `$cmd$`) live inside the body and are preserved.
// Returns '' when no dollar-quoted body is found — an un-diffable definition is skipped, not flagged.
export function extractFunctionBody (def: string): string {
  const open = def.match(/\$[A-Za-z0-9_]*\$/)
  if (!open) return ''
  const tag = open[0]
  const start = open.index! + tag.length
  const end = def.indexOf(tag, start)
  return end === -1 ? '' : def.slice(start, end)
}

// Normalises a function body so a hand-written definition and pg_get_functiondef's stored copy compare
// equal despite cosmetic reindentation: runs of whitespace collapse to a single space and the ends are
// trimmed. Case is preserved — a changed string literal or identifier is real drift.
export function normalizeFunctionBody (body: string): string {
  return body.replace(/\s+/g, ' ').trim()
}

// Normalises a default expression so a hand-written DDL default and information_schema.column_default
// compare equal: lower-cased, casts stripped ('pending'::text -> 'pending', '{}'::integer[] -> '{}'),
// whitespace collapsed, and any redundant outer parens removed.
export function normalizeDefault (expr: string): string {
  return stripOuterParens(expr.toLowerCase().replace(CAST_REGEX, '').replace(/\s+/g, ' ').trim())
}

// Normalises a pg_get_constraintdef string for set comparison: lower-cased, quotes and casts stripped,
// whitespace collapsed.
export function normalizeConstraintDef (def: string): string {
  return def.toLowerCase().replace(/"/g, '').replace(CAST_REGEX, '').replace(/\s+/g, ' ').trim()
}

// --- schema drift detection (presence level) ---

// Every index in the schema, with the table it belongs to and whether it is valid. indisvalid is
// false while an interrupted CREATE INDEX CONCURRENTLY leaves a stub behind. Catalog-only (pg_class/
// pg_index), so it works on CockroachDB/YugabyteDB too.
export function getSchemaIndexes (schema: string) {
  return `
    SELECT c.relname AS name, t.relname AS "table", i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def,
           EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid) AS "constraintBacked"
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '${resolveSchemaName(schema).replace(SINGLE_QUOTE_REGEX, "''")}'
  `
}

// Every function in the schema with its full definition, for the function-body diff. pg_get_functiondef
// returns the stored source verbatim (Postgres does not reformat a function body), so an un-drifted
// function's body is byte-identical to what pg-boss emits. Not supported on CockroachDB, so callers run
// this best-effort.
export function getSchemaFunctions (schema: string) {
  return `
    SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = '${resolveSchemaName(schema).replace(SINGLE_QUOTE_REGEX, "''")}'
  `
}

// The ordered value list of an enum type, for the enum-definition diff. ORDER BY enumsortorder
// preserves declaration order — reordering the enum is itself drift (the numeric base type makes
// created < retry < … < failed load-bearing for state comparisons).
export function getEnumDefinition (schema: string, typeName = 'job_state') {
  return `
    SELECT e.enumlabel AS label
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = '${resolveSchemaName(schema).replace(SINGLE_QUOTE_REGEX, "''")}' AND t.typname = '${typeName}'
    ORDER BY e.enumsortorder
  `
}

// Every column of every table in the schema, for the column presence / default / type / nullability
// diff. Uses pg_attribute + format_type so the type is the canonical SQL form (`integer`, `integer[]`,
// `timestamp with time zone`, `<schema>.job_state`) rather than information_schema's lossy `ARRAY` /
// `USER-DEFINED`; the default expression comes from pg_get_expr. relkind r/p covers ordinary and
// partitioned tables (partition leaves are r). Catalog-only, so it works across backends.
export function getSchemaColumns (schema: string) {
  return `
    SELECT c.relname AS "table", a.attname AS "column",
           format_type(a.atttypid, a.atttypmod) AS "type",
           a.attnotnull AS "notNull",
           pg_get_expr(ad.adbin, ad.adrelid) AS "default"
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = '${resolveSchemaName(schema).replace(SINGLE_QUOTE_REGEX, "''")}'
      AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
  `
}

// Every ordinary ('r') or partitioned ('p') table in the schema, catalog-only (pg_class), for the
// table-presence check. Deliberately independent of getSchemaColumns: that query uses pg_get_expr,
// which is unsupported on some backends and is wrapped in a best-effort try/catch — deriving table
// presence from its (possibly empty-on-failure) result would false-report every managed table as
// missing whenever the column query throws. pg_class is available everywhere, so table presence stays
// reliable even when the column diff is skipped.
export function getSchemaTables (schema: string) {
  return `
    SELECT c.relname AS "table"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '${resolveSchemaName(schema).replace(SINGLE_QUOTE_REGEX, "''")}'
      AND c.relkind IN ('r', 'p')
  `
}

// Every non-NOT-NULL constraint in the schema, with the table it belongs to and its canonical
// definition (pg_get_constraintdef), for the constraint-set diff. contype <> 'n' excludes NOT NULL
// constraints (checked at the column level instead). Catalog-only (pg_constraint), so it works across
// backends.
export function getSchemaConstraints (schema: string) {
  return `
    SELECT rel.relname AS "table", pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = '${resolveSchemaName(schema).replace(SINGLE_QUOTE_REGEX, "''")}' AND con.contype <> 'n'
  `
}

// Pulls the unqualified function name out of a CREATE FUNCTION statement (schema-qualified or not).
export function functionName (def: string): string {
  const m = def.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:[a-z_][\w$]*\.)?"?([\w$]+)"?/i)
  return m ? m[1] : ''
}

export interface LiveIndex {
  name: string
  table: string
  valid: boolean
  def?: string
  /** True when the index backs a constraint (primary key / unique), so it is not a standalone index. */
  constraintBacked?: boolean
}

export interface LiveFunction {
  name: string
  def?: string
}

export interface LiveColumn {
  table: string
  column: string
  default?: string | null
  type?: string
  notNull?: boolean
}

export interface ExpectedColumns {
  table: string
  columns: string[]
  defaults?: Record<string, string>
  types?: Record<string, { type: string, notNull: boolean }>
}

export interface LiveConstraint {
  table: string
  def: string
}

export interface ExpectedConstraints {
  table: string
  constraints: string[]
}

// Function-body diff: an expected function with no catalog entry is missing; a present one whose stored
// body (from pg_get_functiondef) differs from the code's emitted body is mismatched. A function whose
// body cannot be extracted (no dollar-quoted body found) is skipped, not flagged.
function computeFunctionDrift (expected: ManagedFunction[], live: LiveFunction[]) {
  const liveByName = new Map(live.map(f => [f.name, f]))
  const missingFunctions: ManagedFunction[] = []
  const mismatchedFunctions: MismatchedFunction[] = []

  for (const fn of expected) {
    const found = liveByName.get(fn.name)
    if (!found?.def) {
      missingFunctions.push(fn)
      continue
    }
    const actualBody = normalizeFunctionBody(extractFunctionBody(found.def))
    if (actualBody && actualBody !== fn.expectedBody) {
      mismatchedFunctions.push({ ...fn, actualBody, actualDefinition: found.def.replace(/\s+/g, ' ').trim() })
    }
  }

  return { missingFunctions, mismatchedFunctions }
}

// Column presence / default / type / nullability diff per managed table. A table with no live columns
// is skipped (it does not exist — table presence is reported separately), so a missing table never
// floods the report with every column. Default, type, and nullability drift are only checked for
// expected tables that carry the corresponding `defaults`/`types` maps (the fixed managed tables); the
// job/partition tables omit them and are name-only.
export function computeColumnDrift (expected: ExpectedColumns[], live: LiveColumn[]): TableColumnDrift[] {
  const liveByTable = new Map<string, Map<string, LiveColumn>>()
  for (const col of live) {
    let cols = liveByTable.get(col.table)
    if (!cols) liveByTable.set(col.table, cols = new Map())
    cols.set(col.column.toLowerCase(), col)
  }

  const drift: TableColumnDrift[] = []
  for (const { table, columns, defaults, types } of expected) {
    const liveCols = liveByTable.get(table)
    if (!liveCols || liveCols.size === 0) continue
    const expectedSet = new Set(columns)
    const missingColumns = columns.filter(c => !liveCols.has(c))
    const unexpectedColumns = [...liveCols.keys()].filter(c => !expectedSet.has(c))

    const defaultMismatches: Array<{ column: string, expected: string, actual: string }> = []
    const typeMismatches: Array<{ column: string, expected: string, actual: string }> = []
    const nullabilityMismatches: Array<{ column: string, expected: boolean, actual: boolean }> = []

    for (const col of columns) {
      const liveCol = liveCols.get(col)
      if (!liveCol) continue

      if (defaults && defaults[col] !== undefined) {
        const actual = liveCol.default ?? ''
        if (normalizeDefault(defaults[col]) !== normalizeDefault(actual)) {
          defaultMismatches.push({ column: col, expected: defaults[col], actual })
        }
      }

      if (types && types[col]) {
        // Both sides are the canonical format_type() form (expected from the manifest, actual from the
        // live catalog), so a direct comparison suffices — no alias folding needed.
        const actualType = liveCol.type ?? ''
        if (types[col].type !== actualType) {
          typeMismatches.push({ column: col, expected: types[col].type, actual: actualType })
        }
        if (types[col].notNull !== !!liveCol.notNull) {
          nullabilityMismatches.push({ column: col, expected: types[col].notNull, actual: !!liveCol.notNull })
        }
      }
    }

    if (missingColumns.length || unexpectedColumns.length || defaultMismatches.length || typeMismatches.length || nullabilityMismatches.length) {
      drift.push({ table, missingColumns, unexpectedColumns, defaultMismatches, typeMismatches, nullabilityMismatches })
    }
  }
  return drift
}

// Constraint-set diff per managed table. Compares normalised pg_get_constraintdef strings as sets: an
// expected constraint whose normalised form is absent from the live set is missing; a live constraint
// whose normalised form is not expected is unexpected. A table with no live constraints at all (absent
// table) is skipped, so a not-yet-created table never floods the report.
export function computeConstraintDrift (expected: ExpectedConstraints[], live: LiveConstraint[]): ConstraintDrift[] {
  const liveByTable = new Map<string, string[]>()
  for (const { table, def } of live) {
    let defs = liveByTable.get(table)
    if (!defs) liveByTable.set(table, defs = [])
    defs.push(def)
  }

  const drift: ConstraintDrift[] = []
  for (const { table, constraints } of expected) {
    const liveDefs = liveByTable.get(table)
    if (!liveDefs || liveDefs.length === 0) continue
    const liveNormSet = new Set(liveDefs.map(normalizeConstraintDef))
    const expectedNormSet = new Set(constraints.map(normalizeConstraintDef))
    const missingConstraints = constraints.filter(c => !liveNormSet.has(normalizeConstraintDef(c)))
    const unexpectedConstraints = liveDefs.filter(d => !expectedNormSet.has(normalizeConstraintDef(d)))
    if (missingConstraints.length || unexpectedConstraints.length) {
      drift.push({ table, missingConstraints, unexpectedConstraints })
    }
  }
  return drift
}

// Enum diff: ordered value-set comparison. An absent enum (empty actual — pre-enum schema or a backend
// without enums) is not treated as drift. Order is significant; the numeric base type relies on it.
function computeEnumDrift (name: string, expected: readonly string[], actual: string[]): EnumDrift | null {
  if (actual.length === 0) return null
  const same = expected.length === actual.length && expected.every((v, i) => v === actual[i])
  return same ? null : { name, expectedValues: [...expected], actualValues: actual }
}

// Presence + index definition diff: which managed indexes exist, plus (for present, valid ones) a
// key-column-order and partial-predicate comparison. Ordinals are treated asymmetrically, the same
// convention test/pgSchemaHelper.ts encodes — index column ORDER is significant here (an index on
// (a, b) differs from (b, a)); the table-column diff instead normalises ordinal position away.
//
// Generic engine: it carries no pg-boss knowledge. Every dimension is one optional `{ expected, live }`
// entry — none is privileged. `indexes.building` names async builds still in progress (pulled out of
// "missing"); `tables.expected` is the managed table set that scopes the extra-index warning. Each
// dimension is best-effort — callers omit the ones a backend can't support.
export function computeSchemaDrift (
  opts: {
    indexes?: { expected: ManagedIndex[], live: LiveIndex[], building?: ReadonlySet<string> }
    tables?: { expected: string[], live: string[] }
    functions?: { expected: ManagedFunction[], live: LiveFunction[] }
    columns?: { expected: ExpectedColumns[], live: LiveColumn[] }
    enum?: { name: string, expected: readonly string[], actual: string[] }
    constraints?: { expected: ExpectedConstraints[], live: LiveConstraint[] }
  } = {}
): SchemaDriftReport {
  const expectedIndexes = opts.indexes?.expected ?? []
  const liveIndexes = opts.indexes?.live ?? []
  const building = opts.indexes?.building ?? new Set<string>()

  const liveByName = new Map(liveIndexes.map(i => [i.name, i]))
  const expectedNames = new Set(expectedIndexes.map(i => i.name))

  const missing: ManagedIndex[] = []
  const stillBuilding: ManagedIndex[] = []
  const invalid: InvalidIndex[] = []
  const mismatched: MismatchedIndex[] = []

  for (const idx of expectedIndexes) {
    const found = liveByName.get(idx.name)
    if (!found) {
      (building.has(idx.name) ? stillBuilding : missing).push(idx)
    } else if (!found.valid) {
      invalid.push({ ...idx, building: building.has(idx.name) })
    } else if (idx.keys && found.def) {
      // Definition-diff: a present, valid index whose key columns/order or predicate differ from the
      // expected shape. Comparison is on the normalised forms (order-significant, format-insensitive),
      // but the report carries the readable raw text. Only when the key list parses — an unparseable
      // def is skipped, not falsely flagged. (An empty normalised key list means we could not parse the
      // def; '' is never a real key list, whereas an empty predicate is legitimate for a non-partial
      // index.)
      const actualKeys = indexKeysRaw(found.def)
      if (normalizeKeyList(actualKeys)) {
        const expectedPredicate = idx.predicate ?? ''
        const actualPredicate = indexPredicateRaw(found.def)
        const expectedInclude = idx.include ?? ''
        const actualInclude = indexIncludeRaw(found.def)
        const differs: Array<'keys' | 'include' | 'predicate'> = []
        if (normalizeKeyList(idx.keys) !== normalizeKeyList(actualKeys)) differs.push('keys')
        if (normalizeIncludeList(expectedInclude) !== normalizeIncludeList(actualInclude)) differs.push('include')
        if (normalizePredicate(expectedPredicate) !== normalizePredicate(actualPredicate)) differs.push('predicate')
        if (differs.length) {
          mismatched.push({ ...idx, expectedKeys: idx.keys, actualKeys, expectedInclude, actualInclude, expectedPredicate, actualPredicate, actualDefinition: displayIndexDefinition(found.def), differs })
        }
      }
    }
  }

  // Extra indexes: standalone (non-constraint-backing) indexes on a managed table that the expected set
  // does not account for — a stale pg-boss index or one a user added. These are informational (an extra
  // index is harmless), so they are surfaced as a warning and do NOT flip `ok`. Scoped to managed tables
  // so a user's indexes on their own tables in the schema are never reported.
  const managedTables = new Set(opts.tables?.expected ?? expectedIndexes.map(i => i.table))
  const extraIndexes = liveIndexes
    .filter(i => managedTables.has(i.table) && !expectedNames.has(i.name) && !i.constraintBacked)
    .map(i => ({ name: i.name, table: i.table }))

  const liveTables = new Set(opts.tables?.live ?? [])
  const missingTables = (opts.tables?.expected ?? []).filter(t => !liveTables.has(t))

  const { missingFunctions, mismatchedFunctions } = computeFunctionDrift(
    opts.functions?.expected ?? [], opts.functions?.live ?? []
  )
  const columnDrift = opts.columns ? computeColumnDrift(opts.columns.expected, opts.columns.live) : []
  const constraintDrift = opts.constraints ? computeConstraintDrift(opts.constraints.expected, opts.constraints.live) : []
  const enumDrift = opts.enum ? computeEnumDrift(opts.enum.name, opts.enum.expected, opts.enum.actual) : null

  return {
    ok: missingTables.length === 0 && missing.length === 0 && invalid.length === 0 &&
      mismatched.length === 0 && missingFunctions.length === 0 && mismatchedFunctions.length === 0 &&
      columnDrift.length === 0 && constraintDrift.length === 0 && enumDrift === null,
    missingTables,
    missing,
    building: stillBuilding,
    invalid,
    extraIndexes,
    mismatched,
    missingFunctions,
    mismatchedFunctions,
    columnDrift,
    constraintDrift,
    enumDrift
  }
}
