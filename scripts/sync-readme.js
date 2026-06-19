#!/usr/bin/env node
// Keeps docs/index.md in sync with the package README.
//
// docs/index.md is a VitePress "home" page: its frontmatter (the `hero`
// block) is hand-maintained, and everything below the generated marker is
// a verbatim copy of README.md. The README is the source of truth.
//
// Run `npm run docs:readme` after editing README.md. Use `--check` in CI to
// fail (without writing) when the two have drifted.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readmePath = join(root, 'README.md')
const indexPath = join(root, 'docs', 'index.md')

const MARKER = '<!-- The content below is generated from README.md by scripts/sync-readme.js. Do not edit it directly. -->'

// The docs site base URL. README links point at the deployed site with
// absolute URLs; inside the site those should be root-relative so they
// navigate within the same VitePress build instead of leaving the page.
const siteBase = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).homepage
if (!siteBase) {
  throw new Error('package.json: missing "homepage" field used to relativize docs links')
}

// Rewrite markdown links that point back into the docs site into root-relative
// links (e.g. https://timgit.github.io/pg-boss/cli -> /cli, and the bare base
// -> /). External links (GitHub, npm, badges) are left untouched.
function relativizeLinks (text) {
  const escaped = siteBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\]\\(${escaped}(/[^)]*)?\\)`, 'g')
  return text.replace(pattern, (_match, path) => `](${path && path !== '/' ? path : '/'})`)
}

// Drop a top-level (## ...) section, heading through to the next heading of
// the same level (or end of file). Used to omit sections that only make sense
// in the README, not on the docs site itself.
function dropSection (text, heading) {
  const pattern = new RegExp(`^## ${heading}\\b[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm')
  return text.replace(pattern, '')
}

// Drop the README's leading tagline + CI badges; the VitePress hero already
// shows the tagline, and the badges don't belong on the rendered docs home.
// Everything from the first heading or fenced code block onward is the body.
function readmeBody () {
  const lines = readFileSync(readmePath, 'utf8').split('\n')
  const start = lines.findIndex(line => /^(#|```)/.test(line))
  if (start === -1) {
    throw new Error('README.md: could not find a heading or code fence to mark the start of the body')
  }
  let body = lines.slice(start).join('\n')
  // The "Documentation" section just links back to this site, so omit it here.
  body = dropSection(body, 'Documentation')
  body = body.replace(/\s+$/, '') + '\n'
  return relativizeLinks(body)
}

// Preserve the frontmatter block (the second `---`) and rebuild everything below it.
function render () {
  const index = readFileSync(indexPath, 'utf8')
  const match = index.match(/^---\n[\s\S]*?\n---\n/)
  if (!match) {
    throw new Error('docs/index.md: expected a YAML frontmatter block at the top')
  }
  return `${match[0]}\n${MARKER}\n\n${readmeBody()}`
}

const next = render()
const check = process.argv.includes('--check')

if (check) {
  if (readFileSync(indexPath, 'utf8') !== next) {
    console.error('docs/index.md is out of sync with README.md. Run `npm run docs:readme`.')
    process.exit(1)
  }
  console.log('docs/index.md is in sync with README.md.')
} else {
  writeFileSync(indexPath, next)
  console.log('Synced README.md -> docs/index.md')
}
