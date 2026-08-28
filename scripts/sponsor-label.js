#!/usr/bin/env node
// Applies the `sponsor` label to an issue or discussion when its author
// sponsors pg-boss at $50/mo or more.
//
// Run by .github/workflows/sponsor-label.yml on open. Reads the author and the
// labelable from the environment so the same script serves both event types:
//
//   AUTHOR_LOGIN   the login that opened the issue or discussion
//   LABELABLE_ID   the node ID of the issue or discussion
//
// Pass --dry-run to print the decision without mutating anything.
//
// Requires SPONSORS_TOKEN: a classic PAT for the sponsored account with
// read:user, read:org and repo. The Actions GITHUB_TOKEN cannot read
// sponsorship data at all, and read:user alone cannot read the login of an
// Organization sponsor — the API answers a short token with a scope error
// rather than partial data, so a wrong scope fails loudly here rather than
// silently labelling nothing.
//
// Only public sponsorships count. includePrivate is deliberately omitted: a
// private sponsor hid the relationship on purpose, and a public label would
// undo that.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const overridesPath = join(root, '.github', 'sponsors.json')

const REPO_OWNER = 'timgit'
const REPO_NAME = 'pg-boss'
const LABEL = 'sponsor'

// The label is the $50 tier's promise. $10 Backers deliberately do not get it,
// so the tier has to be read even though only one label is ever applied.
// Compare on the number, not the tier name: SponsorsTier.name is derived from
// the price and reads back as the string "$50 a month", so a name match would
// break silently the next time a price moves.
const LABEL_TIER = 50

const SPONSORS_QUERY = `
  query($cursor: String) {
    viewer {
      sponsorshipsAsMaintainer(first: 100, activeOnly: true, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          tier { monthlyPriceInDollars isOneTime }
          sponsorEntity {
            __typename
            ... on User { login }
            ... on Organization { login }
          }
        }
      }
    }
  }
`

const LABEL_QUERY = `
  query($owner: String!, $name: String!, $label: String!) {
    repository(owner: $owner, name: $name) {
      label(name: $label) { id }
    }
  }
`

// addLabelsToLabelable, not the REST endpoint: REST cannot label discussions.
const LABEL_MUTATION = `
  mutation($labelable: ID!, $labels: [ID!]!) {
    addLabelsToLabelable(input: { labelableId: $labelable, labelIds: $labels }) {
      clientMutationId
    }
  }
`

async function graphql (token, query, variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'pg-boss-sponsor-label'
    },
    body: JSON.stringify({ query, variables })
  })

  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} ${response.statusText}`)
  }

  const body = await response.json()

  if (body.errors?.length) {
    throw new Error(`GitHub API error: ${body.errors.map(e => e.message).join('; ')}`)
  }

  return body.data
}

async function fetchSponsorships (token) {
  const sponsorships = []
  let cursor = null

  do {
    const data = await graphql(token, SPONSORS_QUERY, { cursor })
    const page = data?.viewer?.sponsorshipsAsMaintainer

    if (!page) {
      throw new Error('GitHub API returned no sponsorship data. Check that SPONSORS_TOKEN belongs to the sponsored account and carries read:user and read:org.')
    }

    sponsorships.push(...page.nodes)
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)

  return sponsorships
}

// Public members only, and by the REST endpoint that says so in its name.
// GraphQL's membersWithRole returns what the token can see, which is a
// different question and a worse one to get wrong: labelling somebody whose
// membership is private discloses it.
async function fetchPublicMembers (token, org) {
  const members = []
  let page = 1

  while (true) {
    const response = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/public_members?per_page=100&page=${page}`, {
      headers: {
        authorization: `bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'pg-boss-sponsor-label'
      }
    })

    // A sponsoring org that blocks member listing is not an error worth
    // failing the run over — it is what .github/sponsors.json exists for.
    if (!response.ok) {
      console.log(`Could not list public members of ${org} (${response.status}). Falling back to overrides only.`)
      return members
    }

    const body = await response.json()
    members.push(...body.map(member => member.login))

    if (body.length < 100) {
      return members
    }

    page += 1
  }
}

// Phase 4b writes per-sponsor seat mappings into the same file, so this reads
// several shapes rather than assuming its own. Anything that looks like a list
// of logins under a sponsoring org counts:
//
//   { "acme": ["octocat"] }
//   { "acme": { "members": ["octocat"], "seats": ["hubot"] } }
//   { "overrides": { "acme": ["octocat"] } }
function readOverrides () {
  let raw

  try {
    raw = JSON.parse(readFileSync(overridesPath, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.log(`Ignoring ${overridesPath}: ${error.message}`)
    }
    return new Map()
  }

  const source = raw.overrides ?? raw.members ?? raw
  const map = new Map()

  for (const [org, value] of Object.entries(source)) {
    if (org === 'overrides' || org === 'members') {
      continue
    }

    const logins = Array.isArray(value)
      ? value
      : [...(value?.members ?? []), ...(value?.seats ?? [])]

    map.set(org.toLowerCase(), logins.filter(login => typeof login === 'string').map(login => login.toLowerCase()))
  }

  return map
}

async function sponsorsAtOrAbove (token, dollars) {
  const qualifying = sponsorships => sponsorships
    .filter(({ tier, sponsorEntity }) => tier && sponsorEntity && !tier.isOneTime && tier.monthlyPriceInDollars >= dollars)

  const sponsorships = qualifying(await fetchSponsorships(token))
  const overrides = readOverrides()
  const logins = new Set()

  for (const { sponsorEntity } of sponsorships) {
    const login = sponsorEntity.login.toLowerCase()
    logins.add(login)

    // Sponsors are mostly organizations; issue authors are always individuals.
    // Expanding the org is what connects the two.
    if (sponsorEntity.__typename === 'Organization') {
      for (const member of await fetchPublicMembers(token, sponsorEntity.login)) {
        logins.add(member.toLowerCase())
      }

      for (const member of overrides.get(login) ?? []) {
        logins.add(member)
      }
    }
  }

  return logins
}

const token = process.env.SPONSORS_TOKEN
const author = process.env.AUTHOR_LOGIN
const labelable = process.env.LABELABLE_ID
const dryRun = process.argv.includes('--dry-run')

if (!token) {
  console.error('SPONSORS_TOKEN is required.')
  process.exit(1)
}

if (!author) {
  console.error('AUTHOR_LOGIN is required.')
  process.exit(1)
}

try {
  const logins = await sponsorsAtOrAbove(token, LABEL_TIER)

  if (!logins.has(author.toLowerCase())) {
    console.log(`${author} is not a sponsor at $${LABEL_TIER}/mo or above. No label applied.`)
    process.exit(0)
  }

  if (dryRun) {
    console.log(`${author} qualifies. Would apply \`${LABEL}\`.`)
    process.exit(0)
  }

  if (!labelable) {
    console.error('LABELABLE_ID is required unless --dry-run is passed.')
    process.exit(1)
  }

  const label = await graphql(token, LABEL_QUERY, { owner: REPO_OWNER, name: REPO_NAME, label: LABEL })
  const labelId = label?.repository?.label?.id

  if (!labelId) {
    throw new Error(`Repository has no \`${LABEL}\` label. Create it before enabling this workflow.`)
  }

  await graphql(token, LABEL_MUTATION, { labelable, labels: [labelId] })
  console.log(`Applied \`${LABEL}\` for ${author}.`)
} catch (error) {
  // A stack trace here is noise: every realistic failure is a bad token, a
  // revoked scope, a missing label, or GitHub being down.
  console.error(error.message)
  process.exit(1)
}
