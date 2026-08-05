import neostandard from 'neostandard'
import { defineConfig } from 'eslint/config'

const config = neostandard({
  ts: true,
  env: ['mocha'],
  // tutorial/ is a standalone browser page with no build step, so it is not linted with the library.
  ignores: [...neostandard.resolveIgnoresFromGitignore(), 'tutorial/'],
  noJsx: true,
})

export default defineConfig(config, {
  languageOptions: {
    ecmaVersion: 2025,
  },
})
