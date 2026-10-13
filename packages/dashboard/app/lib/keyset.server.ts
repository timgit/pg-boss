// Keyset paging for the dashboard's lists, in the spirit of the core's `after` option: a page
// continues strictly past the boundary row of the one before, so a page costs the same however deep
// it is, and rows inserted or deleted between pages do not shift the next one. Unlike the core,
// whose `after` names a row by id, the cursor carries the boundary row's key values, so paging on
// past a row that has since been deleted still works.

export type KeyType = 'text' | 'int' | 'uuid' | 'timestamptz' | 'bool'

// One ordering key. `expr` must never be null (coalesce a nullable column), since a row comparison
// against null matches nothing. The last key of a list must make the ordering unique.
export interface Key {
  expr: string;
  type: KeyType;
  desc: boolean;
}

// The cursor a request pages from: `after` for the page past it, `before` for the page ahead of it.
export interface Cursor {
  after?: string | null;
  before?: string | null;
}

export interface KeysetPage<T> {
  rows: T[];
  hasNextPage: boolean;
  hasPrevPage: boolean;
  nextCursor: string | null;
  prevCursor: string | null;
  // The page reached the start of the list, so it is page 1 whatever page the URL said.
  atStart: boolean;
}

const CURSOR_COLUMN = '__cursor'

const VALID: Record<KeyType, RegExp> = {
  text: /^[\s\S]*$/,
  int: /^-?\d{1,10}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  timestamptz: /^(-?infinity|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2}){0,2}|Z)?)$/,
  bool: /^(true|false)$/,
}

export function encodeCursor (values: string[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url')
}

// A cursor that does not decode to one valid value per key is ignored, so a mangled URL lands on
// the first page instead of failing the query.
export function decodeCursor (cursor: string | null | undefined, keys: Key[]): string[] | null {
  if (!cursor) return null
  try {
    const values: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Array.isArray(values) || values.length !== keys.length) return null
    return values.every((v, i) => typeof v === 'string' && VALID[keys[i].type].test(v)) ? values as string[] : null
  } catch {
    return null
  }
}

// The keys' values as text, one array per row, for the cursor of the page's first and last rows.
// Text round-trips every key type exactly, including microsecond timestamps a JS Date would round.
export function cursorSelect (keys: Key[]): string {
  return `ARRAY[${keys.map(k => `(${k.expr})::text`).join(', ')}] as "${CURSOR_COLUMN}"`
}

export function keysetOrderBy (keys: Key[], backward: boolean): string {
  return `ORDER BY ${keys.map(k => `${k.expr} ${k.desc !== backward ? 'DESC' : 'ASC'}`).join(', ')}`
}

// The predicate for rows strictly past `values` in the keys' order, or strictly ahead of them when
// `backward`. Keys that all run one way compare as a row, which an index on them can serve; mixed
// directions expand to the equivalent OR chain. Placeholders start at `$first`.
export function keysetCondition (keys: Key[], first: number, backward: boolean): string {
  const op = (k: Key) => (k.desc !== backward ? '<' : '>')
  const param = (i: number) => `$${first + i}::${keys[i].type}`

  if (keys.every(k => k.desc === keys[0].desc)) {
    return `(${keys.map(k => k.expr).join(', ')}) ${op(keys[0])} (${keys.map((_, i) => param(i)).join(', ')})`
  }

  const branches = keys.map((k, i) => {
    const equal = keys.slice(0, i).map((e, j) => `${e.expr} = ${param(j)}`)
    return `(${[...equal, `${k.expr} ${op(k)} ${param(i)}`].join(' AND ')})`
  })
  return `(${branches.join(' OR ')})`
}

export interface KeysetPlan {
  values: string[] | null;
  backward: boolean;
}

// Which way a request pages, and from where. `before` wins when both are present.
export function keysetPlan (cursor: Cursor, keys: Key[]): KeysetPlan {
  const before = decodeCursor(cursor.before, keys)
  if (before) return { values: before, backward: true }
  return { values: decodeCursor(cursor.after, keys), backward: false }
}

type CursorRow<T> = T & { [CURSOR_COLUMN]?: string[] }

// Run a keyset query (`read` gets the plan and must select cursorSelect(keys), order by
// keysetOrderBy and read limit + 1 rows) and turn its rows into a page. The extra row says whether
// the list goes on in the direction read, a backward read is put back in display order, and the
// cursors come from the first and last rows shown. A backward read that reaches the start of the
// list reads the first page instead, so page 1 is always full.
export async function keysetPage<T> (
  keys: Key[],
  cursor: Cursor,
  limit: number,
  read: (plan: KeysetPlan) => Promise<CursorRow<T>[]>
): Promise<KeysetPage<T>> {
  let plan = keysetPlan(cursor, keys)
  let rows = await read(plan)

  if (plan.backward && rows.length <= limit) {
    plan = { values: null, backward: false }
    rows = await read(plan)
  }

  const more = rows.length > limit
  const shown = rows.slice(0, limit)
  if (plan.backward) shown.reverse()

  const hasNextPage = plan.backward || more
  const hasPrevPage = plan.backward || plan.values !== null
  const cursorOf = (row: CursorRow<T> | undefined) => {
    const values = row?.[CURSOR_COLUMN]
    return values ? encodeCursor(values) : null
  }

  return {
    rows: shown.map(({ [CURSOR_COLUMN]: _cursor, ...row }) => row as T),
    hasNextPage,
    hasPrevPage,
    nextCursor: hasNextPage ? cursorOf(shown.at(-1)) : null,
    prevCursor: hasPrevPage ? cursorOf(shown[0]) : null,
    atStart: !hasPrevPage,
  }
}
