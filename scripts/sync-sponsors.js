#!/usr/bin/env node
// Generates the sponsor lists in docs/sponsors.md and the logo grid in
// README.md from GitHub Sponsors.
//
// The prose at the top of docs/sponsors.md is hand-maintained; everything
// below the generated marker is rebuilt from the API. The readme carries the
// same logo grid between its own pair of markers, and reaches docs/index.md
// through `npm run docs:readme`.
//
// Run `npm run docs:sponsors` to refresh. Use `--check` in CI to fail (without
// writing) when the page has drifted from the API.
//
// Requires SPONSORS_TOKEN: a classic PAT for the sponsored account with the
// read:user and read:org scopes. read:user alone is not enough — reading the
// `login` of an Organization sponsor requires read:org, and the API answers a
// token without it with a scope error rather than partial data. The Actions
// GITHUB_TOKEN cannot read sponsorship data at all.
//
// Only public sponsorships are listed. includePrivate is deliberately omitted —
// a private sponsor hid the relationship on purpose, and publishing their logo
// would undo that.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pagePath = join(root, 'docs', 'sponsors.md')
const readmePath = join(root, 'README.md')

const MARKER = '<!-- The lists below are generated from GitHub Sponsors by scripts/sync-sponsors.js. Do not edit them directly. -->'
const README_START = '<!-- sponsors:start The logos below are generated from GitHub Sponsors by scripts/sync-sponsors.js. Do not edit them directly. -->'
const README_END = '<!-- sponsors:end -->'

// The ladder, highest rung first. Thresholds are monthly dollars and mirror what
// the tier descriptions promise, so changing one means changing the other. A
// sponsor lands in the first rung they clear, and anything under the last rung is
// not listed at all. A rung with no occupants renders nothing, so an entry can
// sit here before the tier has sold — which is why Partner and Advisory are
// already listed.
const TIERS = [
  { dollars: 1000, heading: 'Advisory Sponsors', logoSize: 128 },
  { dollars: 500, heading: 'Partner Sponsors', logoSize: 112 },
  { dollars: 250, heading: 'Production Sponsors', logoSize: 96 },
  { dollars: 50, heading: 'Sponsors', logoSize: 64 },
  { dollars: 10, heading: 'Backers' }
]

// Rungs with a logoSize get a grid; the rest get a bulleted list of names.
function tierFor (dollars) {
  return TIERS.find(tier => dollars >= tier.dollars) || null
}

const QUERY = `
  query($cursor: String) {
    viewer {
      sponsorshipsAsMaintainer(first: 100, activeOnly: true, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          createdAt
          tier { monthlyPriceInDollars isOneTime }
          sponsorEntity {
            __typename
            ... on User { login name url websiteUrl avatarUrl(size: 256) }
            ... on Organization { login name url websiteUrl avatarUrl(size: 256) }
          }
        }
      }
    }
  }
`

async function fetchSponsorships (token) {
  const sponsorships = []
  let cursor = null

  do {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'pg-boss-sync-sponsors'
      },
      body: JSON.stringify({ query: QUERY, variables: { cursor } })
    })

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status} ${response.statusText}`)
    }

    const body = await response.json()

    if (body.errors?.length) {
      throw new Error(`GitHub API error: ${body.errors.map(e => e.message).join('; ')}`)
    }

    const page = body.data?.viewer?.sponsorshipsAsMaintainer

    if (!page) {
      throw new Error('GitHub API returned no sponsorship data. Check that SPONSORS_TOKEN belongs to the sponsored account and carries both the read:user and read:org scopes.')
    }

    sponsorships.push(...page.nodes)
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)

  return sponsorships
}

// GitHub does not validate the website field on a profile, so it hands back
// whatever the sponsor typed — including things that only resolve on their own
// machine. Anything that isn't a public http(s) address falls back to the
// sponsor's GitHub profile, which always works.
function publicWebsite (websiteUrl) {
  if (!websiteUrl) {
    return null
  }

  let url

  try {
    // A bare "example.com" is a real answer here; a bare "localhost" is not,
    // and gets rejected below on its own merits.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  // Loopback and link-local names.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return null
  }

  // IPv6 loopback and unique-local.
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
    return null
  }

  // IPv4 loopback, private ranges and link-local.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)

  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number)
    return (a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31))
      ? null
      : url.href
  }

  // Anything left without a dot is a bare host name, not a public site.
  return host.includes('.') ? url.href : null
}

// One-time sponsorships are excluded: placement is sold as ongoing, and a
// one-time sponsor has nothing left to cancel. Sponsors below the lowest rung
// are dropped too — a custom $5 amount has no section to land in.
function toSponsors (sponsorships) {
  return sponsorships
    .filter(({ tier, sponsorEntity }) => tier && sponsorEntity && !tier.isOneTime)
    .map(({ tier, sponsorEntity, createdAt }) => ({
      dollars: tier.monthlyPriceInDollars,
      tier: tierFor(tier.monthlyPriceInDollars),
      createdAt,
      login: sponsorEntity.login,
      name: sponsorEntity.name || sponsorEntity.login,
      // Their own site if they published a usable one, otherwise their profile.
      href: publicWebsite(sponsorEntity.websiteUrl) || sponsorEntity.url,
      avatar: sponsorEntity.avatarUrl
    }))
    .filter(sponsor => sponsor.tier)
    // Highest tier first, then longest-standing, then alphabetical. Stable
    // ordering keeps a scheduled run from producing a diff with no news in it.
    .sort((a, b) =>
      b.dollars - a.dollars ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.login.localeCompare(b.login))
}

function escapeAttribute (text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// A flex grid with inline styles, so the page needs no custom theme CSS. Each
// logo is sized by its rung, which is what keeps a $250 sponsor from rendering
// pixel-identical to a $50 one.
function renderLogos (sponsors) {
  const items = sponsors.map(({ name, href, avatar, tier }) => {
    const alt = escapeAttribute(name)
    const size = tier.logoSize
    return `  <a href="${escapeAttribute(href)}" target="_blank" rel="noopener">` +
      `<img src="${escapeAttribute(avatar)}" alt="${alt}" title="${alt}" width="${size}" height="${size}" style="border-radius: 8px;"></a>`
  })

  return `<div style="display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin: 1.5rem 0;">\n${items.join('\n')}\n</div>`
}

function renderNames (sponsors) {
  return sponsors.map(({ name, href }) => `- [${name}](${href})`).join('\n')
}

// One section per rung, highest first. A rung with no occupants prints nothing:
// an empty heading advertises a tier nobody bought.
function renderLists (sponsors) {
  const sections = TIERS
    .map(tier => ({ tier, members: sponsors.filter(sponsor => sponsor.tier === tier) }))
    .filter(({ members }) => members.length)
    .map(({ tier, members }) =>
      `## ${tier.heading}\n\n${tier.logoSize ? renderLogos(members) : renderNames(members)}`)

  if (!sections.length) {
    return '_No public sponsors yet._'
  }

  return sections.join('\n\n')
}

// The readme shows only the logo grid, as one grid rather than per-rung sections
// — the rungs stay legible there through logo size alone. Backers are named on
// the docs page, which the readme section links to.
function renderReadme (readme, sponsors) {
  const start = readme.indexOf(README_START)
  const end = readme.indexOf(README_END)

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md: missing the generated marker pair:\n${README_START}\n${README_END}`)
  }

  const logos = sponsors.filter(sponsor => sponsor.tier.logoSize)
  const grid = logos.length ? `\n${renderLogos(logos)}\n` : '\n'

  return `${readme.slice(0, start)}${README_START}${grid}${readme.slice(end)}`
}

function render (page, sponsors) {
  const marker = page.indexOf(MARKER)

  if (marker === -1) {
    throw new Error(`docs/sponsors.md: missing the generated marker comment:\n${MARKER}`)
  }

  const prose = page.slice(0, marker)
  return `${prose}${MARKER}\n\n${renderLists(sponsors)}\n`
}

const token = process.env.SPONSORS_TOKEN

if (!token) {
  console.error('SPONSORS_TOKEN is not set. It needs a classic PAT for the sponsored account with the read:user and read:org scopes; the Actions GITHUB_TOKEN cannot read sponsorship data.')
  process.exit(1)
}

const page = readFileSync(pagePath, 'utf8')
const readme = readFileSync(readmePath, 'utf8')

let outputs

try {
  const sponsors = toSponsors(await fetchSponsorships(token))
  outputs = [
    { label: 'docs/sponsors.md', path: pagePath, current: page, next: render(page, sponsors) },
    { label: 'README.md', path: readmePath, current: readme, next: renderReadme(readme, sponsors) }
  ]
} catch (error) {
  // A stack trace here is noise: every realistic failure is a bad token, a
  // revoked scope, or GitHub being down.
  console.error(error.message)
  process.exit(1)
}

const stale = outputs.filter(({ current, next }) => current !== next)

if (process.argv.includes('--check')) {
  if (stale.length) {
    console.error(`${stale.map(o => o.label).join(' and ')} out of sync with GitHub Sponsors. Run \`npm run docs:sponsors\`.`)
    process.exit(1)
  }
  console.log('Sponsor lists are in sync with GitHub Sponsors.')
} else if (!stale.length) {
  console.log('Sponsor lists are already up to date.')
} else {
  for (const { label, path, next } of stale) {
    writeFileSync(path, next)
    console.log(`Synced GitHub Sponsors -> ${label}`)
  }
  console.log('Run `npm run docs:readme` to carry the readme grid into docs/index.md.')
}
