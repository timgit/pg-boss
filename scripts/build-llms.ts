/**
 * Generates docs/llms.txt (an llms.txt-standard index) and docs/llms-full.txt (every doc
 * concatenated). Run via `bun run docs:llms`; the Pages workflow runs it before deploying.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const REPO = 'khromov/bun-boss'
const BRANCH = 'main'
const DOCS = join(import.meta.dir, '..', 'docs')
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/docs`

// Curated reading order first; any other .md files are appended alphabetically.
const ORDER = [
  'introduction.md',
  'install.md',
  'database-backends.md',
  'api/constructor.md',
  'api/jobs.md',
  'api/workers.md',
  'api/queues.md',
  'api/scheduling.md',
  'api/ops.md',
  'api/events.md',
  'api/adapters.md',
  'api/testing.md',
  'api/utils.md',
  'sql/job-table.md',
  'sql/queue-functions.md'
]

async function listMarkdown (dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      // vendor/ holds third-party assets, not documentation.
      if (entry.name === 'images' || entry.name === 'vendor') continue
      files.push(...(await listMarkdown(join(dir, entry.name), rel)))
    } else if (entry.name.endsWith('.md') && entry.name !== '_sidebar.md') {
      files.push(rel)
    }
  }
  return files
}

function title (md: string, path: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)
  return h1 ? h1[1].trim() : path
}

function summary (md: string): string {
  const body = md.replace(/^#\s+.+$/m, '')
  const para = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#'))
  if (!para) return ''
  const oneLine = para.replace(/\s+/g, ' ')
  const firstSentence = oneLine.match(/^(.+?[.!?])(\s|$)/)
  return (firstSentence ? firstSentence[1] : oneLine).slice(0, 200)
}

const found = await listMarkdown(DOCS)
const ordered = [...ORDER.filter((f) => found.includes(f)), ...found.filter((f) => !ORDER.includes(f)).sort()]

const docs = await Promise.all(
  ordered.map(async (path) => ({ path, content: await readFile(join(DOCS, path), 'utf8') }))
)

const indexLines = [
  '# bun-boss',
  '',
  '> An experimental Bun-first job queue on PostgreSQL, embedded PGlite, and embedded SQLite (a fork of pg-boss). Exactly-once delivery via SKIP LOCKED, with cron scheduling, workers, queues, and job flows.',
  '',
  'The full documentation concatenated into a single file is available at ' + `${RAW_BASE}/llms-full.txt` + '.',
  '',
  '## Docs',
  ''
]
for (const { path, content } of docs) {
  const desc = summary(content)
  indexLines.push(`- [${title(content, path)}](${RAW_BASE}/${path})${desc ? `: ${desc}` : ''}`)
}
await writeFile(join(DOCS, 'llms.txt'), indexLines.join('\n') + '\n')

const fullParts = [
  '# bun-boss documentation',
  '',
  'Generated from https://github.com/' + REPO + ' (branch ' + BRANCH + ').',
  ''
]
for (const { path, content } of docs) {
  fullParts.push('', '---', '', `# File: docs/${path}`, '', content.trim(), '')
}
await writeFile(join(DOCS, 'llms-full.txt'), fullParts.join('\n') + '\n')

console.log(`Wrote docs/llms.txt and docs/llms-full.txt (${docs.length} pages).`)
