/** The colors a schema can be marked with, in the order they are handed out by position. */
export const SCHEMA_COLORS = {
  blue: '#4f7cf7',
  amber: '#e0a43a',
  green: '#3fb27f',
  purple: '#a371f7',
  red: '#e5534b',
} as const

export type SchemaColor = keyof typeof SCHEMA_COLORS

const ORDER = Object.keys(SCHEMA_COLORS) as SchemaColor[]

/** Whether `value` names one of the colors. Its own keys only: `in` would also take `constructor`. */
export function isSchemaColor (value: unknown): value is SchemaColor {
  return typeof value === 'string' && Object.hasOwn(SCHEMA_COLORS, value)
}

/**
 * A schema's color: the one it was given, or one by its place in the configuration, so a switch
 * shows even out of the corner of an eye. Red is last: on the first schema it would read as an alarm.
 */
export function schemaColor (color: SchemaColor | undefined, index: number): SchemaColor {
  return color ?? ORDER[index % ORDER.length]
}
