import type { OutboxRecord } from "./outbox"

/**
 * AQU-1957: a `comment.*` outbox event the server will never accept —
 * quarantined on a 403 (role floor, the org's `commentCreateMinRole`, a
 * membership revoked mid-session) or retry-exhausted on a deterministic 4xx.
 *
 * `useComments` adds every mutation optimistically and `mergeWithOptimistic`
 * keeps a record that is "not yet in server rows" forever, on the assumption
 * that the flush simply hasn't landed. A refused comment never lands, so the
 * assumption makes the drawer lie: the comment sits in the thread looking
 * posted, nobody else ever sees it, and it is gone after a reload. That is the
 * "can write comments but cannot submit them" report — the composer accepted
 * the text and nothing said why it never arrived.
 *
 * Like `useRefusedFileEvents` (AQU-797) this reads the outbox rather than a
 * flush callback, so a refusal is caught whichever path burned the record: the
 * background drain in `useOutboxFlusher` (which passes no `onForbidden`) or any
 * of ProjectWorkspace's foreground `flushOutboxBatch` calls.
 */
export interface CommentRefusal {
  /** Outbox record id — stable, so a caller reacts to it exactly once. */
  id: string
  /** The comment the refused event was about (`payload.commentId`). */
  commentId: string
  /** `comment.create` | `comment.edit` | `comment.delete` | `comment.resolve`. */
  kind: string
  /** The refusal's HTTP status (403 for a quarantine, any 4xx for exhaustion). */
  status: number
  /** The server's reason, when it gave one. */
  reason: string | null
}

/**
 * `failed` alone is not enough: `requeueTransientlyFailedOutboxEvents` revives
 * records whose last error was a network drop (status 0) or a 5xx on the next
 * reconnect, so those are still going to be sent and their comment must stand.
 * A 4xx is deterministic — the same event fails the same way forever.
 */
function isPermanentlyRefused(record: OutboxRecord): boolean {
  if (record.status !== "failed") return false
  const status = record.lastError?.status
  return status !== undefined && status >= 400 && status < 500
}

/** The `commentId` a `comment.*` payload addresses, or null when it carries none. */
function commentIdOf(record: OutboxRecord): string | null {
  const id = (record.event.payload as { commentId?: unknown } | null | undefined)?.commentId
  return typeof id === "string" && id !== "" ? id : null
}

/**
 * Every permanently-refused `comment.*` record for `projectId`, oldest first.
 * A record with no `commentId` in its payload is skipped: there is no comment
 * to roll back, and the generic forbidden banner (AQU-633) still reports it.
 */
export function commentRefusalsIn(
  records: readonly OutboxRecord[],
  projectId: string,
): CommentRefusal[] {
  const refusals: CommentRefusal[] = []
  for (const record of records) {
    if (!record.event.kind.startsWith("comment.")) continue
    if (record.event.projectId !== projectId) continue
    if (!isPermanentlyRefused(record)) continue
    // SUB-8 (AQU-633): a refusal the user has already acknowledged on the
    // workspace banner stays in the outbox inspector but stops being reported,
    // so the drawer's notice clears with the banner instead of sticking
    // forever (nothing else ever retires a `failed` record).
    if (record.acknowledgedAt) continue
    const commentId = commentIdOf(record)
    if (!commentId) continue
    refusals.push({
      id: record.id,
      commentId,
      kind: record.event.kind,
      status: record.lastError?.status ?? 0,
      reason: record.lastError?.reason ?? null,
    })
  }
  return refusals
}

/** Cheap identity: same record ids + reasons in the same order → no re-render. */
export function sameCommentRefusals(
  a: readonly CommentRefusal[],
  b: readonly CommentRefusal[],
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].reason !== b[i].reason) return false
  }
  return true
}
