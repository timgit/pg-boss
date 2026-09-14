import type { ProServerOverlay } from '~/lib/pro-contract'

/**
 * Server half of a fixture overlay, resolved through the `~pro-server` alias.
 * Unlike `index.tsx` this must never import React: it is bundled into the Node
 * server, not the browser.
 */
export const serverOverlay: ProServerOverlay = {
  ownsAuth: true,
  server: (app) => {
    app.get('/pro-probe', (c) => c.text('overlay'))
  },
}

export default serverOverlay
