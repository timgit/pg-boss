import { createContext } from 'react'

/**
 * The current schema when the root loader found no pg-boss in it, for the error card to name. Null
 * when pg-boss is installed, when the database can't be asked, and outside the app.
 */
export const MissingPgBossContext = createContext<{ name: string, connection: { schema: string } } | null>(null)
