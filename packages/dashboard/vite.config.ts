import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { resolveBasePath } from './app/lib/base-path.ts'
import { proAlias, proServerAlias } from './app/lib/pro-overlay.ts'
import { thirdPartyPlugin } from './scripts/third-party.ts'

const { viteBase } = resolveBasePath(process.env.PGBOSS_DASHBOARD_BASE_PATH)

// Kept as runtime imports: React and React Router must stay a single shared copy, and `pg`
// loads optional native bindings. Everything else is bundled into the server build.
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
  'react',
  'react-dom',
  'react-router',
]

export default defineConfig(({ command }) => ({
  // Vite bakes `base` into asset URLs at build time, which is what production
  // deployments behind a sub-path need. In dev we keep it at `/`: the React
  // Router dev server requires `basename` to start with `base`, and the dev
  // server serves assets from the root regardless of the app's basename.
  base: command === 'build' ? viteBase : '/',
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
  resolve: {
    alias: {
      '~': '/app',
      '~pro': proAlias(),
      // The dev server imports this through the SSR runner to build the same
      // Hono app production does; without the alias here it resolves to nothing
      // and the overlay's server half is silently absent from `npm run dev`.
      '~pro-server': proServerAlias(),
      'pg-boss': resolve(import.meta.dirname, '../../src'),
    },
    // Force a single copy of React in the dev module graph. Without this, Vite's
    // dependency optimizer can pre-bundle a second React instance for a dep that
    // imports it (react-router, @base-ui/react, lucide-react, …), and the two
    // instances surface at runtime as `Cannot read properties of null (reading
    // 'useContext')` — React's dispatcher is null because hooks run against a
    // different React than the one doing the render.
    dedupe: ['react', 'react-dom'],
  },
}))
