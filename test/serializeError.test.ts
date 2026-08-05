import { describe, it, expect } from './harness.ts'
import { serializeError } from '../src/serialize-error.ts'

// The in-house replacement for the `serialize-error` package. Its only job is to turn whatever a
// caller hands to complete()/fail() into a plain, JSON-safe object for the `output` jsonb column —
// crucially flattening an Error's non-enumerable message/stack/name, which JSON.stringify drops.

// The output always feeds a jsonb bind, so it must survive JSON.stringify without throwing.
function jsonSafe (value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe('serializeError', function () {
  describe('Error flattening', function () {
    it('exposes the non-enumerable message/name/stack that JSON.stringify would drop', function () {
      const raw = new Error('boom')
      expect(JSON.stringify(raw)).toBe('{}')

      const out = serializeError(raw) as Record<string, string>
      expect(out.message).toBe('boom')
      expect(out.name).toBe('Error')
      expect(typeof out.stack).toBe('string')
    })

    it('keeps enumerable custom properties on an Error', function () {
      const raw = new Error('custom error') as Error & { something: string, code: string }
      raw.something = 'clever'
      raw.code = 'E_CUSTOM'

      const out = serializeError(raw) as Record<string, string>
      expect(out.something).toBe('clever')
      expect(out.code).toBe('E_CUSTOM')
    })

    it('preserves deeply nested objects hung off an Error', function () {
      const raw = new Error('Something went wrong') as Error & { some: unknown }
      raw.some = { deeply: { nested: { reason: 'nuna' } } }

      const out = serializeError(raw) as { some: { deeply: { nested: { reason: string } } } }
      expect(out.some.deeply.nested.reason).toBe('nuna')
    })

    it('recursively serializes the error cause', function () {
      const raw = new Error('outer', { cause: new Error('inner') })

      const out = serializeError(raw) as { cause: { message: string } }
      expect(out.cause.message).toBe('inner')
    })

    it('serializes the aggregated errors of an AggregateError', function () {
      const raw = new AggregateError([new Error('a'), new Error('b')], 'many failed')

      const out = serializeError(raw) as { message: string, errors: Array<{ message: string }> }
      expect(out.message).toBe('many failed')
      expect(out.errors.map(e => e.message)).toEqual(['a', 'b'])
    })
  })

  describe('JSON safety', function () {
    it('replaces a circular reference with a marker instead of throwing', function () {
      const raw: Record<string, unknown> = { message: 'mhmm' }
      raw.myself = raw

      const out = serializeError(raw) as Record<string, unknown>
      expect(out.message).toBe('mhmm')
      expect(out.myself).toBe('[Circular]')
      expect(() => jsonSafe(out)).not.toThrow()
    })

    it('encodes a bigint as a string so JSON.stringify does not throw', function () {
      const out = serializeError({ big: 10n }) as Record<string, string>
      expect(out.big).toBe('10n')
      expect(() => jsonSafe(out)).not.toThrow()
    })

    it('drops function-valued properties', function () {
      const out = serializeError({ keep: 1, drop () { return 2 } }) as Record<string, unknown>
      expect(out.keep).toBe(1)
      expect('drop' in out).toBe(false)
    })

    it('marks Buffer and stream-like values instead of dumping their bytes', function () {
      const out = serializeError({ buf: Buffer.from('hi'), s: { pipe () {} } }) as Record<string, string>
      expect(out.buf).toBe('[object Buffer]')
      expect(out.s).toBe('[object Stream]')
    })

    it('honors toJSON (e.g. Date renders as its ISO string)', function () {
      const out = serializeError({ when: new Date(0) }) as Record<string, string>
      expect(out.when).toBe('1970-01-01T00:00:00.000Z')
    })
  })

  describe('non-object input', function () {
    it('wraps a thrown primitive as a NonError with a descriptive message', function () {
      const out = serializeError('mah error') as Record<string, string>
      expect(out.name).toBe('NonError')
      expect(out.message).toBe('Non-error value: mah error')
    })

    it('passes plain objects through unchanged', function () {
      const out = serializeError({ value: 'mah error' }) as Record<string, string>
      expect(out.value).toBe('mah error')
    })
  })
})
