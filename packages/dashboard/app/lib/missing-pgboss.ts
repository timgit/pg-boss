import { createContext } from 'react'

/**
 * The current database when the root loader found no pg-boss schema in it, for the error card to
 * name. Null when pg-boss is installed, when the database can't be asked, and outside the app.
 */
export const MissingPgBossContext = createContext<{ name: string, schema: string } | null>(null)
