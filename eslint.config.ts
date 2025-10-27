import neostandard from 'neostandard'
import { defineConfig } from 'eslint/config'

const config = neostandard({
  ts: true,
  env: ['mocha'],
  ignores: neostandard.resolveIgnoresFromGitignore(),
  noJsx: true,
})

export default defineConfig(config, {
  languageOptions: {
    ecmaVersion: 2025,
  },
})
