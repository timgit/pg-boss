import { describe, expect, it } from 'vitest'
import { isSchemaColor, SCHEMA_COLORS } from '~/lib/schema-colors'

describe('isSchemaColor', () => {
  it('takes each color by name', () => {
    for (const name of Object.keys(SCHEMA_COLORS)) expect(isSchemaColor(name)).toBe(true)
  })

  it('refuses another name, a name every object inherits, and anything not a string', () => {
    expect(isSchemaColor('teal')).toBe(false)
    expect(isSchemaColor('constructor')).toBe(false)
    expect(isSchemaColor('toString')).toBe(false)
    expect(isSchemaColor(null)).toBe(false)
  })
})
