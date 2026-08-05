/* Checks the tutorial against the source it teaches.
 *
 *   bun tutorial/verify-excerpts.mjs
 *
 * Every code panel that names a `file` must appear in that file verbatim, and its declared
 * `lines` must be where it actually is. Also validates slide structure. Exits non-zero on
 * any failure so this can be run before committing a change to src/. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

/* slides.js and diagrams.js are classic browser scripts, so give them a `window` and run them. */
function loadScript (name) {
  const win = {}
  const src = readFileSync(resolve(here, name), 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win)
  return win.PGB
}

const { SLIDES } = loadScript('slides.js')
const { DIAGRAMS } = loadScript('diagrams.js')

const problems = []
const fileCache = new Map()

function readSource (rel) {
  if (!fileCache.has(rel)) {
    try {
      fileCache.set(rel, readFileSync(resolve(repo, rel), 'utf8').split('\n').map(trimEnd))
    } catch (err) {
      fileCache.set(rel, null)
    }
  }
  return fileCache.get(rel)
}

const trimEnd = (line) => line.replace(/\s+$/, '')

/* Returns every 0-based offset in `haystack` where `needle` appears as a run of lines. */
function findRuns (haystack, needle) {
  const hits = []
  const limit = haystack.length - needle.length
  for (let i = 0; i <= limit; i++) {
    let ok = true
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) { ok = false; break }
    }
    if (ok) hits.push(i)
  }
  return hits
}

/* ---------- structure ---------- */

const seen = new Set()
const chapters = new Map()

for (const [index, slide] of SLIDES.entries()) {
  const where = `slide ${index + 1} (${slide.id || 'no id'})`

  if (!slide.id) problems.push(`${where}: missing id`)
  else if (seen.has(slide.id)) problems.push(`${where}: duplicate id`)
  seen.add(slide.id)

  if (!slide.chapter) problems.push(`${where}: missing chapter`)
  if (!slide.title) problems.push(`${where}: missing title`)
  if (!slide.body) problems.push(`${where}: missing body`)
  if (!slide.panels || !slide.panels.length) problems.push(`${where}: no panels`)

  chapters.set(slide.chapter, (chapters.get(slide.chapter) || 0) + 1)

  if (slide.quiz) {
    const q = slide.quiz
    if (!q.q || !q.explain) problems.push(`${where}: quiz missing question or explanation`)
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      problems.push(`${where}: quiz needs 2-4 options`)
    } else if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) {
      problems.push(`${where}: quiz answer ${q.answer} out of range`)
    }
  }

  for (const [k, panel] of (slide.panels || []).entries()) {
    const at = `${where} panel ${k + 1}`

    if (panel.kind === 'svg') {
      if (!DIAGRAMS[panel.name]) problems.push(`${at}: no diagram named "${panel.name}"`)
      continue
    }

    if (!panel.text) { problems.push(`${at}: empty code panel`); continue }
    if (!panel.file) {
      if (!panel.label) problems.push(`${at}: code panel needs a file or a label`)
      continue
    }

    const source = readSource(panel.file)
    if (!source) { problems.push(`${at}: cannot read ${panel.file}`); continue }

    const excerpt = panel.text.replace(/\n+$/, '').split('\n').map(trimEnd)
    const hits = findRuns(source, excerpt)

    if (hits.length === 0) {
      // Narrow the report to the first line that does not appear anywhere in the file.
      const orphan = excerpt.find((line) => line && !source.includes(line))
      problems.push(
        `${at}: excerpt not found in ${panel.file}` +
        (orphan ? `\n      first unmatched line: ${JSON.stringify(orphan)}` : '')
      )
      continue
    }

    const actual = hits.length === 1
      ? `${hits[0] + 1}-${hits[0] + excerpt.length}`
      : hits.map((h) => `${h + 1}-${h + excerpt.length}`).join(' or ')

    if (!panel.lines) {
      problems.push(`${at}: ${panel.file} has no declared lines (actual ${actual})`)
    } else if (!hits.some((h) => `${h + 1}-${h + excerpt.length}` === panel.lines)) {
      problems.push(`${at}: ${panel.file}:${panel.lines} is stale — excerpt is actually at ${actual}`)
    }
  }
}

/* ---------- report ---------- */

console.log(`${SLIDES.length} slides, ${chapters.size} chapters`)
for (const [chapter, count] of chapters) console.log(`  ${String(count).padStart(2)}  ${chapter}`)

const checked = SLIDES.flatMap((s) => s.panels || []).filter((p) => p.kind !== 'svg' && p.file).length
const diagrams = SLIDES.flatMap((s) => s.panels || []).filter((p) => p.kind === 'svg').length
console.log(`\n${checked} verbatim excerpts checked, ${diagrams} diagram panels`)

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log('\nall excerpts match their source')
