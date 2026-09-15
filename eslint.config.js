import neostandard from 'neostandard'
import { defineConfig } from 'eslint/config'

const config = neostandard({
  ts: true,
  env: ['mocha'],
  ignores: neostandard.resolveIgnoresFromGitignore(),
  noJsx: true,
})

// Ensure Postgres timestamp API calls in SQL statements go through
// ${schema}.job_now() so a test clock can redirect them (pg-boss #901).
const SQL_CLOCK_CALLS = String.raw`(^|[^.\w])(now|transaction_timestamp|statement_timestamp|clock_timestamp|timeofday|age)\(`
const SQL_CLOCK_KEYWORDS = String.raw`\b(CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\b`
const SQL_CLOCK_INPUT_STRINGS = String.raw`'(now|today|tomorrow|yesterday)'`
const SQL_CLOCK_MESSAGE = 'SQL must read the clock through the schema-owned job_now() function (pg-boss #901)'

export default defineConfig(config, {
  languageOptions: {
    ecmaVersion: 2025,
  },
}, {
  files: ['src/**/*.ts'],
  rules: {
    'no-restricted-syntax': ['error',
      { selector: `TemplateElement[value.raw=/${SQL_CLOCK_CALLS}/i]`, message: SQL_CLOCK_MESSAGE },
      { selector: `Literal[value=/${SQL_CLOCK_CALLS}/i]`, message: SQL_CLOCK_MESSAGE },
      { selector: `TemplateElement[value.raw=/${SQL_CLOCK_KEYWORDS}/i]`, message: SQL_CLOCK_MESSAGE },
      { selector: `Literal[value=/${SQL_CLOCK_KEYWORDS}/i]`, message: SQL_CLOCK_MESSAGE },
      { selector: `TemplateElement[value.raw=/${SQL_CLOCK_INPUT_STRINGS}/i]`, message: SQL_CLOCK_MESSAGE },
      { selector: `Literal[value=/${SQL_CLOCK_INPUT_STRINGS}/i]`, message: SQL_CLOCK_MESSAGE }
    ]
  }
})
