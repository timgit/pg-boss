import neostandard from 'neostandard'
import { defineConfig } from 'eslint/config'

const config = neostandard({
  ts: true,
  env: ['mocha'],
  ignores: neostandard.resolveIgnoresFromGitignore(),
  noJsx: true,
})

// Every clock read in pg-boss SQL goes through ${schema}.now() so a TestClock can redirect it
// (pg-boss #689). Postgres has eleven spellings of "the current time" once age( is counted;
// reject them all inside string and template contents under src/. Diagnostics that compare
// against pg_stat_* catalog timestamps opt out with a disable/enable block that states why. age(
// is included because the one-argument form reads current_date and a regex cannot tell it from
// age(xid). The quoted input strings 'now', 'today', 'tomorrow' and 'yesterday' read the
// transaction clock as well and are rejected on the same grounds.
const SQL_CLOCK_CALLS = String.raw`(^|[^.\w])(now|transaction_timestamp|statement_timestamp|clock_timestamp|timeofday|age)\(`
const SQL_CLOCK_KEYWORDS = String.raw`\b(CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\b`
const SQL_CLOCK_INPUT_STRINGS = String.raw`'(now|today|tomorrow|yesterday)'`
const SQL_CLOCK_MESSAGE = 'SQL must read the clock through the schema-qualified now() function (pg-boss #689)'

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
