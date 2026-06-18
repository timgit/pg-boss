import type { IDatabase } from '../types.ts'

// Minimal structural type for an `@electric-sql/pglite` instance, so pg-boss does not take a
// hard dependency on the package. Both methods return an object with a `rows` array.
export interface PGliteLike {
  query<T = any>(query: string, params?: unknown[]): Promise<{ rows: T[] }>
  exec(query: string): Promise<Array<{ rows: any[] }>>
}

// Adapts a PGlite instance (embedded single-connection WASM PostgreSQL) to pg-boss's IDatabase.
// PGlite is full PostgreSQL, so it needs none of the distributed compatibility flags — pair it
// with `backend: 'pglite'`. The user owns the PGlite instance lifecycle (construction and close).
//
// PGlite uses native `$1` placeholders, so no placeholder translation is needed. The one wrinkle is
// that `query()` runs a single statement only, while pg-boss issues concatenated multi-statement DDL
// (migrations/schema creation) with no parameters — those must go through `exec()`, which mirrors the
// simple-vs-extended protocol split that the default `pg.Pool`-backed driver relies on.
export function fromPglite (pglite: PGliteLike): IDatabase {
  return {
    async executeSql (text: string, values?: unknown[]) {
      if (values?.length) {
        return await pglite.query(text, values)
      }

      // No parameters: may be a multi-statement DDL block. exec() returns one result per statement;
      // pg-boss only reads rows from single-statement parameterized queries, so returning the last
      // statement's rows (or an empty set) is sufficient.
      const results = await pglite.exec(text)
      return { rows: results.at(-1)?.rows ?? [] }
    }
  }
}
