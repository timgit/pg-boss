import neostandard from 'neostandard'
import { defineConfig } from 'eslint/config'

const config = neostandard({
  ts: true,
  ignores: neostandard.resolveIgnoresFromGitignore(),
  noJsx: true,
})

export default defineConfig(config, {
  // Third-party minified assets vendored verbatim; not ours to lint.
  ignores: ['docs/vendor/**'],
}, {
  languageOptions: {
    ecmaVersion: 2025,
  },
}, {
  // Bun injects bare test globals that bypass the harness's wrapped `it` (no per-test schema
  // setup), so every test symbol must be imported from test/harness.ts explicitly.
  files: ['test/**/*.ts'],
  rules: {
    'no-restricted-globals': [
      'error',
      ...['it', 'test', 'describe', 'expect', 'beforeAll', 'beforeEach', 'afterEach', 'afterAll']
        .map(name => ({ name, message: `Import ${name} from './harness.ts' instead of using the injected global.` })),
    ],
  },
})
