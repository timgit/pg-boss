// Derived from sindresorhus/serialize-error (MIT, Copyright (c) Sindre Sorhus), reduced to the one
// mode the library uses: serializeError() in serialize + forceEnumerable mode, infinite depth,
// honoring toJSON. Its job is to flatten an Error's non-enumerable name/message/stack (plus
// cause/errors/code) into a plain, JSON-safe object so a failed job's `output` column records what
// actually went wrong instead of the `{}` that JSON.stringify(anError) yields.

type PlainRecord = Record<string, unknown>

// Re-copied onto `to` as enumerable after the own-key walk, because on an Error these are
// non-enumerable and so are skipped by Object.keys and lost by JSON.stringify.
const ERROR_PROPERTIES = ['name', 'message', 'stack', 'code', 'cause', 'errors'] as const

// Mirrors the `non-error` package's message for a thrown non-Error value.
function stringifyNonError (value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return `[Function${value.name ? ` ${value.name}` : ' (anonymous)'}]`

  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    try {
      return String(value)
    } catch {
      return '<Unserializable value>'
    }
  }
}

function isBuffer (value: unknown): boolean {
  return value instanceof Uint8Array && value.constructor.name === 'Buffer'
}

function isStream (value: unknown): value is { pipe: unknown } {
  return value !== null && typeof value === 'object' && typeof (value as PlainRecord).pipe === 'function'
}

function destroyCircular (from: PlainRecord, seen: Set<unknown>): unknown {
  const to: PlainRecord | unknown[] = Array.isArray(from) ? [] : {}

  seen.add(from)

  if (typeof (from as PlainRecord).toJSON === 'function') {
    seen.delete(from)
    return (from as { toJSON: () => unknown }).toJSON()
  }

  const recurse = (value: PlainRecord) => destroyCircular(value, seen)

  for (const key of Object.keys(from)) {
    const value = (from as PlainRecord)[key]

    if (isBuffer(value)) {
      (to as PlainRecord)[key] = '[object Buffer]'
      continue
    }

    if (isStream(value)) {
      (to as PlainRecord)[key] = '[object Stream]'
      continue
    }

    if (typeof value === 'function') {
      continue
    }

    if (typeof value === 'bigint') {
      (to as PlainRecord)[key] = `${value}n`
      continue
    }

    if (!value || typeof value !== 'object') {
      (to as PlainRecord)[key] = value
      continue
    }

    (to as PlainRecord)[key] = seen.has(value) ? '[Circular]' : recurse(value as PlainRecord)
  }

  for (const property of ERROR_PROPERTIES) {
    const value = (from as PlainRecord)[property]
    if (value === undefined || value === null) continue

    const processed = (typeof value === 'object')
      ? (seen.has(value) ? '[Circular]' : recurse(value as PlainRecord))
      : value

    Object.defineProperty(to, property, {
      value: processed,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }

  seen.delete(from)
  return to
}

export function serializeError (value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    return destroyCircular(value as PlainRecord, new Set())
  }

  // A thrown non-object: wrap it the way the `non-error` package did before serializing — an Error
  // subclass, so the flattened result carries name/message/stack like any other serialized error.
  const wrapped = new Error(`Non-error value: ${stringifyNonError(typeof value === 'function' ? '<Function>' : value)}`)
  wrapped.name = 'NonError'

  return destroyCircular(wrapped as unknown as PlainRecord, new Set())
}
