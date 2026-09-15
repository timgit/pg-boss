// The worker side of PGliteWorker. Every tab/instance spawns one of these; they contend for
// `pglite-election-lock:${id}` and exactly one wins and holds the real PGlite instance.
import { PGlite } from '@electric-sql/pglite'
import { worker } from '@electric-sql/pglite/worker'

worker({
  init: async options => new PGlite({ dataDir: options.dataDir })
})
