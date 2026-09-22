import neostandard from 'neostandard'
import { defineConfig } from 'eslint/config'

// resolveIgnoresFromGitignore() reads the root .gitignore only, so a nested one is invisible here.
// packages/dashboard/app/pro is ignored by packages/dashboard/.gitignore: it is the Pro overlay,
// mounted into a dashboard checkout from the separate Pro repository and owned by it. Linting a
// working copy that happens to have the overlay mounted reports findings against source this
// repository cannot fix, so the ignore has to be stated again for eslint.
const PRO_OVERLAY = 'packages/dashboard/app/pro/**'

const config = neostandard({
  ts: true,
  env: ['mocha'],
  ignores: [...neostandard.resolveIgnoresFromGitignore(), PRO_OVERLAY],
  noJsx: true,
})

// Ensure Postgres timestamp API calls in SQL statements go through
// ${schema}.job_now() so a test clock can redirect them (pg-boss #689).
const SQL_CLOCK_CALLS = String.raw`(^|[^.\w])(now|transaction_timestamp|statement_timestamp|clock_timestamp|timeofday|age)\(`
const SQL_CLOCK_KEYWORDS = String.raw`\b(CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\b`
const SQL_CLOCK_INPUT_STRINGS = String.raw`'(now|today|tomorrow|yesterday)'`
const SQL_CLOCK_MESSAGE = 'SQL must read the clock through the schema-owned job_now() function (pg-boss #689)'

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
