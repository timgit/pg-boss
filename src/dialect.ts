// The SQL dialect seam. plans.ts builders accept a Ctx (a bare schema string, or a PlanContext
// carrying a Dialect) and render names/expressions through these primitives, so one builder can
// serve both dialects. A bare string resolves to POSTGRES, which keeps every static caller
// (CLI, migrationStore, construction plans) and every existing test byte-identical — the
// postgres primitives must always return exactly the text plans.ts interpolated before the seam
// existed (guarded by test/plansSnapshotTest.ts).

export type DialectName = 'postgres' | 'sqlite'

// Job states in enum declaration order. Must match plans.JOB_STATES and the manifest enum —
// relational state predicates (state < 'active') depend on this order, and the sqlite dialect
// expands them into IN-lists derived from it (TEXT comparison would order the names
// alphabetically and silently return wrong rows).
export const JOB_STATE_ORDER = ['created', 'retry', 'active', 'completed', 'cancelled', 'failed'] as const

export type JobStateName = typeof JOB_STATE_ORDER[number]

function statesBefore (state: JobStateName, inclusive: boolean): string[] {
  const index = JOB_STATE_ORDER.indexOf(state)
  return JOB_STATE_ORDER.slice(0, inclusive ? index + 1 : index)
}

function statesAfter (state: JobStateName): string[] {
  return JOB_STATE_ORDER.slice(JOB_STATE_ORDER.indexOf(state) + 1)
}

function inList (expr: string, states: string[]): string {
  return `${expr} IN (${states.map(s => `'${s}'`).join(', ')})`
}

export interface Dialect {
  name: DialectName

  // Renders a schema-qualified object name. Postgres has real schemas; SQLite has none, so the
  // qualified name becomes a single quoted identifier ("pgboss.job") in the main database —
  // keeping pg-boss objects co-located (and transactional) with the application's own tables.
  qualify(schema: string, object: string): string

  // Renders the index name for CREATE INDEX. Postgres creates the index in the table's schema
  // from a bare name; SQLite's index namespace is flat per database, so the name carries the
  // same quoted schema prefix as tables to stay unique across pg-boss instances.
  qualifyIndex(schema: string, index: string): string

  // Current timestamp expression. SQLite stores ISO-8601 UTC text with milliseconds — fixed
  // width, so lexicographic comparison equals chronological and JS `new Date()` parses it.
  now(): string

  // Timestamp expression a number of seconds (a SQL expression) after now.
  nowPlusSeconds(secondsExpr: string): string

  // Timestamp expression a number of seconds (a SQL expression) after another timestamp.
  tsPlusSeconds(tsExpr: string, secondsExpr: string): string

  // Timestamp expression a literal interval before now.
  nowMinusInterval(value: number, unit: 'days' | 'seconds'): string

  // Staleness predicate: true when column is NULL or older than `seconds` ago.
  staleAfter(column: string, seconds: number): string

  // NULL test of an optional text / timestamp parameter (postgres needs the cast to type the
  // placeholder; SQLite parameters are untyped).
  textParamIsNull(param: string): string
  tsParamIsNull(param: string): string

  // Membership of an expression in a literal string list (attorney-validated values only).
  inArrayLiteral(expr: string, values: string[]): string

  // Relational job-state predicates. Postgres compares enum ordinals; SQLite expands the
  // ordered-state list into an IN-list because TEXT comparison would use alphabetical order.
  stateLt(expr: string, state: JobStateName): string
  stateLte(expr: string, state: JobStateName): string
  stateGt(expr: string, state: JobStateName): string

  // Membership test of an expression against an array parameter. The sqlite adapter binds
  // JS arrays as JSON text, queried with json_each.
  inArrayParam(expr: string, param: string, pgArrayType: string): string

  // JSON key-existence test on a jsonb/TEXT-JSON expression.
  jsonHasKey(expr: string, key: string): string

  // A bound parameter used as a JSON document. Postgres casts the text to jsonb; SQLite's json
  // functions read JSON text directly.
  jsonParam(param: string): string

  // Extracts a typed scalar from a JSON expression. SQLite's ->> already returns SQL-typed
  // values (numbers as INTEGER/REAL, booleans as 1/0), so no cast is needed there.
  jsonGet(expr: string, key: string, pgType: string): string

  // Like jsonGet, but the key is a SQL expression rather than a literal.
  jsonGetExpr(expr: string, keyExpr: string, pgType: string): string

  // A bound parameter used as an integer.
  intParam(param: string): string

  // Integer cast of an expression.
  castInt(expr: string): string

  // Non-membership of an expression against an array parameter (NULL-safe like <> ALL only
  // when the caller guards, matching today's usage).
  notInArrayParam(expr: string, param: string, pgArrayType: string): string

  // Membership of an expression in a subquery's result. Postgres materializes the subquery
  // into an array InitPlan so the planner treats it as a one-time input.
  inSubquery(expr: string, subquery: string): string

  // JSON object aggregation over grouped rows, empty object when no rows.
  jsonObjectAgg(keyExpr: string, valueExpr: string): string

  // Array aggregation (postgres array / JSON array text).
  arrayAgg(expr: string): string

  // Variadic maximum/minimum of scalar expressions.
  greatest(...exprs: string[]): string
  least(...exprs: string[]): string

  // Table alias syntax in UPDATE ... SET. SQLite requires AS.
  updateAlias(qualified: string, alias: string): string

  // Alias qualification of RETURNING columns — SQLite rejects alias-qualified names there.
  returningAlias(alias: string): string

  // Wraps statements in the dialect's transaction block. SQLite has no SET LOCAL; BEGIN
  // IMMEDIATE takes the write lock up front so acquisition honors busy_timeout instead of
  // failing mid-script on a read-to-write upgrade.
  transaction(sql: string): string
}

export interface PlanContext {
  schema: string
  dialect?: Dialect
}

export type Ctx = string | PlanContext

// The timestamp text format the sqlite dialect writes (strftime('%Y-%m-%dT%H:%M:%fZ', ...)).
// Date parameters must be bound through this so bound values compare correctly against
// SQL-generated timestamps. JS toISOString() produces the identical shape.
export function toSqliteTimestamp (date: Date): string {
  return date.toISOString()
}

export const SQLITE_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

export const POSTGRES: Dialect = {
  name: 'postgres',
  qualify: (schema, object) => `${schema}.${object}`,
  qualifyIndex: (_schema, index) => index,
  now: () => 'now()',
  nowPlusSeconds: (secondsExpr) => `now() + ${secondsExpr} * interval '1s'`,
  tsPlusSeconds: (tsExpr, secondsExpr) => `${tsExpr} + ${secondsExpr} * interval '1s'`,
  nowMinusInterval: (value, unit) => `now() - interval '${value} ${unit}'`,
  staleAfter: (column, seconds) => `EXTRACT( EPOCH FROM (now() - COALESCE(${column}, now() - interval '1 week') ) ) > ${seconds}`,
  textParamIsNull: (param) => `${param}::text IS NULL`,
  tsParamIsNull: (param) => `${param}::timestamptz IS NULL`,
  inArrayLiteral: (expr, values) => `${expr} = ANY(ARRAY[${values.map(v => `'${v.replace(/'/g, "''")}'`).join(',')}]::text[])`,
  stateLt: (expr, state) => `${expr} < '${state}'`,
  stateLte: (expr, state) => `${expr} <= '${state}'`,
  stateGt: (expr, state) => `${expr} > '${state}'`,
  inArrayParam: (expr, param, pgArrayType) => `${expr} = ANY(${param}::${pgArrayType})`,
  jsonHasKey: (expr, key) => `jsonb_exists(${expr}, '${key}')`,
  jsonParam: (param) => `${param}::jsonb`,
  jsonGet: (expr, key, pgType) => `(${expr}->>'${key}')::${pgType}`,
  jsonGetExpr: (expr, keyExpr, pgType) => `(${expr} ->> ${keyExpr})::${pgType}`,
  intParam: (param) => `${param}::int`,
  castInt: (expr) => `${expr}::int`,
  notInArrayParam: (expr, param, pgArrayType) => `${expr} <> ALL(${param}::${pgArrayType})`,
  inSubquery: (expr, subquery) => `${expr} = ANY (ARRAY(${subquery}))`,
  jsonObjectAgg: (keyExpr, valueExpr) => `COALESCE(jsonb_object_agg(${keyExpr}, ${valueExpr}), '{}'::jsonb)`,
  arrayAgg: (expr) => `array_agg(${expr})`,
  greatest: (...exprs) => `GREATEST(${exprs.join(', ')})`,
  least: (...exprs) => `LEAST(${exprs.join(', ')})`,
  updateAlias: (qualified, alias) => `${qualified} ${alias}`,
  returningAlias: (alias) => `${alias}.`,
  transaction: (sql) => `
    BEGIN;
    SET LOCAL lock_timeout = 30000;
    SET LOCAL idle_in_transaction_session_timeout = 30000;
    ${sql};
    COMMIT;
  `
}

export const SQLITE: Dialect = {
  name: 'sqlite',
  qualify: (schema, object) => `"${schema}.${object}"`,
  qualifyIndex: (schema, index) => `"${schema}.${index}"`,
  now: () => SQLITE_NOW,
  nowPlusSeconds: (secondsExpr) => `strftime('%Y-%m-%dT%H:%M:%fZ', unixepoch('subsec') + ${secondsExpr}, 'unixepoch')`,
  tsPlusSeconds: (tsExpr, secondsExpr) => `strftime('%Y-%m-%dT%H:%M:%fZ', unixepoch(${tsExpr}, 'subsec') + ${secondsExpr}, 'unixepoch')`,
  nowMinusInterval: (value, unit) => `strftime('%Y-%m-%dT%H:%M:%fZ', unixepoch('subsec') - ${value * (unit === 'days' ? 86400 : 1)}, 'unixepoch')`,
  staleAfter: (column, seconds) => `(unixepoch('subsec') - unixepoch(COALESCE(${column}, '1970-01-01T00:00:00.000Z'), 'subsec')) > ${seconds}`,
  textParamIsNull: (param) => `${param} IS NULL`,
  tsParamIsNull: (param) => `${param} IS NULL`,
  inArrayLiteral: (expr, values) => `${expr} IN (${values.map(v => `'${v.replace(/'/g, "''")}'`).join(',')})`,
  stateLt: (expr, state) => inList(expr, statesBefore(state, false)),
  stateLte: (expr, state) => inList(expr, statesBefore(state, true)),
  stateGt: (expr, state) => inList(expr, statesAfter(state)),
  inArrayParam: (expr, param) => `${expr} IN (SELECT value FROM json_each(${param}))`,
  jsonHasKey: (expr, key) => `json_type(${expr}, '$.${key}') IS NOT NULL`,
  jsonParam: (param) => param,
  jsonGet: (expr, key) => `${expr} ->> '${key}'`,
  jsonGetExpr: (expr, keyExpr) => `${expr} ->> ${keyExpr}`,
  intParam: (param) => param,
  castInt: (expr) => `CAST(${expr} AS INTEGER)`,
  notInArrayParam: (expr, param) => `${expr} NOT IN (SELECT value FROM json_each(${param}))`,
  inSubquery: (expr, subquery) => `${expr} IN (${subquery})`,
  jsonObjectAgg: (keyExpr, valueExpr) => `COALESCE(json_group_object(${keyExpr}, ${valueExpr}), '{}')`,
  arrayAgg: (expr) => `json_group_array(${expr})`,
  greatest: (...exprs) => `max(${exprs.join(', ')})`,
  least: (...exprs) => `min(${exprs.join(', ')})`,
  updateAlias: (qualified, alias) => `${qualified} AS ${alias}`,
  returningAlias: () => '',
  transaction: (sql) => `
    BEGIN IMMEDIATE;
    ${sql};
    COMMIT;
  `
}

export const DIALECTS: Record<DialectName, Dialect> = {
  postgres: POSTGRES,
  sqlite: SQLITE
}

export function sch (c: Ctx): string {
  return typeof c === 'string' ? c : c.schema
}

export function dial (c: Ctx): Dialect {
  return typeof c === 'string' ? POSTGRES : (c.dialect ?? POSTGRES)
}

export function qn (c: Ctx, object: string): string {
  return dial(c).qualify(sch(c), object)
}

export function isSqliteDialect (c: Ctx): boolean {
  return dial(c).name === 'sqlite'
}
