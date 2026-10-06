export type QueueView = 'cards' | 'table'

/** Remembers the viewer's last choice of view, so `/queues` opens on it without a `view` param. */
export const QUEUE_VIEW_COOKIE = 'pgboss-queues-view'

/** Cards unless the value says table. */
export function parseQueueView (raw: string | null | undefined): QueueView {
  return raw === 'table' ? 'table' : 'cards'
}
