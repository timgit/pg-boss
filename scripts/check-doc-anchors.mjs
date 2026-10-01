#!/usr/bin/env node
// Checks every anchor link against the heading ids VitePress gives the docs pages: relative links
// inside docs/, and https://pgboss.io links in docs/ and src/ (the @see lines in doc comments).
//
// Run `npm run docs:anchors`. Exits 1 on a broken or unresolvable anchor. With `--fix`, rewrites a
// broken anchor that has exactly one heading matching it once hyphens are ignored, the usual miss
// being a GitHub-style slug (#fetchname-options for fetch(name, options)).

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(root, 'docs')
const fix = process.argv.includes('--fix')

// VitePress's default slugify (vitepress/src/node/slugify.ts), copied so this runs without the docs
// dependencies installed.
// eslint-disable-next-line no-control-regex
const rControl = /[\u0000-\u001f]/g
const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g
const rCombining = /[̀-ͯ]/g
const slugify = (str) => str.normalize('NFKD').replace(rCombining, '').replace(rControl, '').replace(rSpecial, '-')
  .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, '_$1').toLowerCase()

function walk (dir, ext) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.vitepress', 'dist'].includes(entry.name)) return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path, ext)
    return path.endsWith(ext) ? [path] : []
  })
}

const pageKey = (file) => relative(docs, file).replace(/\.(md|html)$/, '')

// The ids of each page's headings, keyed by its path under docs/ without the extension. A repeated
// heading gets -1, -2 and so on, as VitePress numbers them.
const mdFiles = walk(docs, '.md')
const ids = new Map()

for (const file of mdFiles) {
  const set = new Set()
  const seen = {}
  let fence = false

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue

    const heading = line.match(/^#{1,6}\s+(.*?)\s*$/)
    if (!heading) continue

    const explicit = heading[1].match(/\{#([^}]+)\}\s*$/)
    if (explicit) {
      set.add(explicit[1])
      continue
    }

    const text = heading[1].replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '')
    let id = slugify(text)
    if (seen[id] !== undefined) {
      seen[id]++
      id = `${id}-${seen[id]}`
    } else {
      seen[id] = 0
    }
    set.add(id)
  }

  ids.set(pageKey(file), set)
}

const SITE_LINK = /https:\/\/pgboss\.io\/([a-z0-9/-]*)#([a-z0-9_-]+)/g
// A markdown link with an anchor whose target is not an absolute URL: another page, or this one.
const RELATIVE_LINK = /\]\((?![a-z][a-z0-9+.-]*:)([^)\s#]*)#([^)\s]+)\)/gi

const broken = []

function check (file, link, target, anchor) {
  const set = ids.get(target) ?? ids.get(join(target, 'index'))
  if (!set) {
    broken.push(`${relative(root, file)}: no page for ${link}`)
    return link
  }
  if (set.has(anchor)) return link

  const loose = (s) => s.replace(/-/g, '')
  const candidates = [...set].filter(id => loose(id) === loose(anchor))

  if (fix && candidates.length === 1) {
    console.log(`${relative(root, file)}: #${anchor} -> #${candidates[0]}`)
    return link.replace(`#${anchor}`, `#${candidates[0]}`)
  }

  broken.push(`${relative(root, file)}: #${anchor} in ${target} (${candidates.length ? `did you mean #${candidates.join(', #')}?` : 'no matching heading'})`)
  return link
}

for (const file of [...mdFiles, ...walk(join(root, 'src'), '.ts')]) {
  const original = readFileSync(file, 'utf8')

  let text = original.replace(SITE_LINK, (link, path, anchor) => check(file, link, path.replace(/\/$/, '') || 'index', anchor))

  if (file.startsWith(docs)) {
    text = text.replace(RELATIVE_LINK, (link, path, anchor) => {
      const target = path === '' ? pageKey(file) : pageKey(resolve(dirname(file), path))
      return check(file, link, target, anchor)
    })
  }

  if (text !== original) writeFileSync(file, text)
}

if (broken.length) {
  console.error(broken.join('\n'))
  console.error(`\n${broken.length} broken anchor${broken.length === 1 ? '' : 's'}${fix ? '' : '. Run with --fix to rewrite the ones with a single match.'}`)
  process.exit(1)
}

console.log('All doc anchors resolve.')
