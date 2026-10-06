/** How `/queues` draws its queues: 'table' on its own, or whichever views an overlay offers. */
export type QueueView = string

/** Remembers the viewer's last choice of view, so `/queues` opens on it without a `view` param. */
export const QUEUE_VIEW_COOKIE = 'pgboss-queues-view'

/** The view named, when it is one on offer; else the default, or the first on offer. */
export function parseQueueView (raw: string | null | undefined, views: readonly QueueView[] = ['table'], fallback: QueueView = views[0]): QueueView {
  return raw && views.includes(raw) ? raw : fallback
}
