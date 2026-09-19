// Never imported. types/handler.d.ts is written by hand (esbuild emits no declarations), and
// this makes `npm run typecheck` fail if it drifts from the implementation.
import type * as Declared from '../types/handler'
import type * as Implemented from './handler'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

export const publishedTypesMatch: [
  Equal<typeof Declared.createDashboardHandler, typeof Implemented.createDashboardHandler>,
  Equal<Declared.CreateDashboardHandlerOptions, Implemented.CreateDashboardHandlerOptions>,
  Equal<Declared.DatabaseInput, Implemented.DatabaseInput>,
  Equal<Declared.DashboardHandler, Implemented.DashboardHandler>
] = [true, true, true, true]
