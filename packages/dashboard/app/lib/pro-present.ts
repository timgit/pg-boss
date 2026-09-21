import overlay from '~pro'

/**
 * Whether this build carries a Pro overlay, for the UI that has to say so.
 *
 * The chrome needs this for one thing: the tier badge beside the wordmark,
 * which must not appear in the free dashboard. Everything else the overlay adds
 * announces itself by existing — a nav row, a slot's contents — and needs no
 * flag.
 *
 * Derived from the overlay rather than from `PGBOSS_PRO`. The flag is read at
 * build time by `proEnabled()`, and the sidebar renders in a browser where
 * `process.env` is not a thing; plumbing it through the root loader would make
 * a customer's *runtime* environment able to change what the product calls
 * itself, which is worse than inferring it. The stub is empty by definition —
 * `pro-stub.ts` is `{ nav: [], slots: {} }` — so anything in either field is an
 * overlay that was selected at build time and bundled.
 *
 * A constant rather than a function: `~pro` is resolved by an alias at build
 * time and cannot change while the page is open.
 */
export const proPresent =
  overlay.nav.length > 0 || Object.keys(overlay.slots).length > 0
