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
}, {
  files: ['test/**/*.ts'],
  rules: {
    'no-restricted-syntax': ['error', {
      selector: "CallExpression[callee.property.name='getJobById']",
      message: 'getJobById() is deprecated; use findJobs({ id }) instead',
    }],
  },
})
