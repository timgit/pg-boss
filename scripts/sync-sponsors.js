#!/usr/bin/env node
// Generates the sponsor lists in docs/sponsors.md from GitHub Sponsors.
//
// The prose at the top of docs/sponsors.md is hand-maintained; everything
// below the generated marker is rebuilt from the API.
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

const MARKER = '<!-- The lists below are generated from GitHub Sponsors by scripts/sync-sponsors.js. Do not edit them directly. -->'

// Tier thresholds, in monthly dollars. These mirror what the tier descriptions
// promise, so changing one means changing the other.
const LOGO_TIER = 50
const NAME_TIER = 10

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
            ... on User { login name url websiteUrl avatarUrl(size: 200) }
            ... on Organization { login name url websiteUrl avatarUrl(size: 200) }
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
// one-time sponsor has nothing left to cancel.
function toSponsors (sponsorships) {
  return sponsorships
    .filter(({ tier, sponsorEntity }) => tier && sponsorEntity && !tier.isOneTime)
    .map(({ tier, sponsorEntity, createdAt }) => ({
      dollars: tier.monthlyPriceInDollars,
      createdAt,
      login: sponsorEntity.login,
      name: sponsorEntity.name || sponsorEntity.login,
      // Their own site if they published a usable one, otherwise their profile.
      href: publicWebsite(sponsorEntity.websiteUrl) || sponsorEntity.url,
      avatar: sponsorEntity.avatarUrl
    }))
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

// A flex grid with inline styles, so the page needs no custom theme CSS.
function renderLogos (sponsors) {
  const items = sponsors.map(({ name, href, avatar }) => {
    const alt = escapeAttribute(name)
    return `  <a href="${escapeAttribute(href)}" target="_blank" rel="noopener">` +
      `<img src="${escapeAttribute(avatar)}" alt="${alt}" title="${alt}" width="64" height="64" style="border-radius: 8px;"></a>`
  })

  return `<div style="display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin: 1.5rem 0;">\n${items.join('\n')}\n</div>`
}

function renderNames (sponsors) {
  return sponsors.map(({ name, href }) => `- [${name}](${href})`).join('\n')
}

function renderLists (sponsors) {
  const logos = sponsors.filter(s => s.dollars >= LOGO_TIER)
  const names = sponsors.filter(s => s.dollars >= NAME_TIER && s.dollars < LOGO_TIER)
  const sections = []

  if (logos.length) {
    sections.push(`## Companies\n\n${renderLogos(logos)}`)
  }

  if (names.length) {
    sections.push(`## Backers\n\n${renderNames(names)}`)
  }

  if (!sections.length) {
    return '_No public sponsors yet._'
  }

  return sections.join('\n\n')
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

let next

try {
  next = render(page, toSponsors(await fetchSponsorships(token)))
} catch (error) {
  // A stack trace here is noise: every realistic failure is a bad token, a
  // revoked scope, or GitHub being down.
  console.error(error.message)
  process.exit(1)
}

const check = process.argv.includes('--check')

if (check) {
  if (page !== next) {
    console.error('docs/sponsors.md is out of sync with GitHub Sponsors. Run `npm run docs:sponsors`.')
    process.exit(1)
  }
  console.log('docs/sponsors.md is in sync with GitHub Sponsors.')
} else if (page === next) {
  console.log('docs/sponsors.md is already up to date.')
} else {
  writeFileSync(pagePath, next)
  console.log('Synced GitHub Sponsors -> docs/sponsors.md')
}
