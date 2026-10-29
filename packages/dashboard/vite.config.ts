import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { resolveBasePath } from './app/lib/base-path.ts'
import { proAlias, proServerAlias } from './app/lib/pro-overlay.ts'
import { thirdPartyPlugin } from './scripts/third-party.ts'
import { coreAlias, coreFromSource } from './scripts/core-alias.ts'

const { viteBase } = resolveBasePath(process.env.PGBOSS_DASHBOARD_BASE_PATH)

// Kept as runtime imports: React and React Router must stay a single shared copy, `pg` loads
// optional native bindings, and `pg-boss` is a declared dependency, so an application that
// mounts the handler shares its own copy when the ranges overlap. Everything else is bundled
// into the server build.
//
// `isbot` looks like it does not belong here — ordinary JavaScript, no shared
// state, no native code — and bundling it would be one fewer package a consumer
// installs. It stays because `@react-router/dev` will not have it otherwise: with
// no `app/entry.server.tsx` of our own it supplies its default, which imports
// isbot, and `resolveEntryFiles` checks `dependencies` (not devDependencies) on
// every dev and build run. Finding it missing, it writes `isbot: "^5"` into
// package.json and shells out to `npm install` mid-build. Moving it to
// devDependencies does not remove a dependency; it gives the toolchain a reason
// to edit the manifest and reinstall behind your back.
//
// The way out is our own entry.server.tsx, which short-circuits that check. That
// is a file to own and keep in step with react-router's default, and it is not
// worth it to avoid shipping one small package that the server genuinely loads.
const SERVER_RUNTIME_PACKAGES = [
  '@react-router/node',
  'isbot',
  'pg',
  'pg-boss',
  'react',
  'react-dom',
  'react-router',
]

// Packages that only ever run on the server. Listed so the dev client optimizer
// leaves them alone; see the `optimizeDeps` note below for why it would otherwise
// pick them up. `pg-boss` pulls in the other three transitively.
const SERVER_ONLY_PACKAGES = [
  'cron-parser',
  'pg',
  'pg-boss',
  'rrule-temporal',
  'serialize-error',
]

export default defineConfig(({ command }) => {
  if (command === 'build' && coreFromSource) {
    throw new Error('PGBOSS_CORE=src is for dev and tests. Unset it to build: a release runs against the published pg-boss.')
  }
  return {
    // Vite bakes `base` into asset URLs at build time, which is what production
    // deployments behind a sub-path need. In dev we keep it at `/`: the React
    // Router dev server requires `basename` to start with `base`, and the dev
    // server serves assets from the root regardless of the app's basename.
    base: command === 'build' ? viteBase : '/',
    // A Pro dev server's aliases differ from the free one's, so the two would otherwise
    // re-optimize one shared cache under each other and serve the page two Reacts.
    cacheDir: process.env.PGBOSS_PRO === '1' ? 'node_modules/.vite-pro' : 'node_modules/.vite',
    plugins: [
      tailwindcss(),
      reactRouter(),
      // Records which third-party packages ended up in the bundles, so the notices
      // describe what is redistributed rather than what happens to be installed.
      // The two stopped being the same thing when the server build started
      // bundling its dependencies.
      thirdPartyPlugin(),
    ],
    // Left external, the UI libraries had to be installed whole (lucide-react alone is ~45 MB
    // for ~20 icons). Build only: the dev server evaluates inlined modules as ESM, which breaks
    // on the CommonJS-only `use-sync-external-store` that @base-ui/react depends on.
    ssr: command === 'build'
      ? { noExternal: true, external: SERVER_RUNTIME_PACKAGES }
      : undefined,
    // Dev only. A browser package the dev server finds after start is pre-bundled
    // mid-request, and Vite then reloads the page ("optimized dependencies changed"),
    // so the click that reached it lands back where it started. React Router's
    // `future.unstable_optimizeDeps` gives the scan every route module as an entry,
    // so every browser package is found at start instead, with no list to keep here.
    //
    // The scan crawls before React Router's `.server` transform runs, so it follows
    // routes into `db.server.ts` and decides the browser needs `pg-boss` and what it
    // imports. `exclude` keeps those out. Server-only packages it does pre-bundle are
    // never requested by the browser, so they cost start time and no reload.
    optimizeDeps: {
      exclude: SERVER_ONLY_PACKAGES,
    },
    resolve: {
      alias: {
        '~': '/app',
        '~pro': proAlias(),
        // `app/entry.server.tsx` exports this, and every server reads the overlay's
        // Hono half from there. Without the alias the build cannot resolve it.
        '~pro-server': proServerAlias(),
        // `pg-boss` is the installed package, unless PGBOSS_CORE=src points it at
        // this repository's source for dev; see scripts/core-alias.ts.
        ...coreAlias(),
      },
      // Force a single copy of React in the dev module graph. Without this, Vite's
      // dependency optimizer can pre-bundle a second React instance for a dep that
      // imports it (react-router, @base-ui/react, lucide-react, …), and the two
      // instances surface at runtime as `Cannot read properties of null (reading
      // 'useContext')` — React's dispatcher is null because hooks run against a
      // different React than the one doing the render.
      dedupe: ['react', 'react-dom'],
    },
  }
})
