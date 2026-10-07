/** The colors a database can be marked with, in the order they are handed out by position. */
export const DATABASE_COLORS = {
  blue: '#4f7cf7',
  amber: '#e0a43a',
  green: '#3fb27f',
  purple: '#a371f7',
  red: '#e5534b',
} as const

export type DatabaseColor = keyof typeof DATABASE_COLORS

const ORDER = Object.keys(DATABASE_COLORS) as DatabaseColor[]

export function isDatabaseColor (value: unknown): value is DatabaseColor {
  return typeof value === 'string' && value in DATABASE_COLORS
}

/**
 * A database's color: the one it was given, or one by its place in the configuration, so a switch
 * shows even out of the corner of an eye. Red is last: on the first database it would read as an alarm.
 */
export function databaseColor (color: DatabaseColor | undefined, index: number): DatabaseColor {
  return color ?? ORDER[index % ORDER.length]
}
