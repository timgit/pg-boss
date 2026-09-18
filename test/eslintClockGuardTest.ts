import { describe, it } from 'vitest'
import { ESLint } from 'eslint'
import { expect } from './hooks.ts'

// Every later clock-seam change leans on this rule. A config typo or a later block that resets
// no-restricted-syntax would fail open silently, so lint fixtures through the real config.
const lint = async (source: string) => {
  const eslint = new ESLint({ cwd: process.cwd() })
  const [result] = await eslint.lintText(source, { filePath: 'src/__clock_guard_fixture__.ts' })
  return result.messages.filter(m => m.ruleId === 'no-restricted-syntax')
}

describe('eslint clock guard', function () {
  it('rejects a bare now() in SQL under src/', async function () {
    const errors = await lint('export const q = `SELECT 1 WHERE start_after <= now()`\n')
    expect(errors).toHaveLength(1)
  })

  it('rejects CURRENT_TIMESTAMP and the quoted input string now', async function () {
    expect(await lint("export const a = 'SELECT CURRENT_TIMESTAMP'\n")).toHaveLength(1)
    expect(await lint("export const b = `SELECT 'now'::timestamptz`\n")).toHaveLength(1)
  })

  it('accepts the schema-qualified form', async function () {
    const errors = await lint('export const q = (schema: string) => `SELECT 1 WHERE start_after <= $' + '{schema}.job_now()`\n')
    expect(errors).toHaveLength(0)
  })
})
