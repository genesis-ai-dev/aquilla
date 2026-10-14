// Message shapes for the side-effect queue (AQU-1824).
//
// Every fan-out side effect this worker fires in response to a user action used
// to run as `ctx.waitUntil(fetch(...))` inside the request invocation: no
// retry, no idempotency, no dead letter, and a ~30 s budget after the response
// was already sent. A provider blip lost the work permanently (one
// `console.warn`), and a comment that @-mentions hundreds of members ran into
// the per-invocation subrequest and time limits.
//
// This module is the shared vocabulary for moving that work onto one
// Cloudflare Queue with a dead-letter queue. Comment / @mention mail is the
// tracer slice; the follow-up tickets (Monday nudges, org-settings fan-out,
// link-notify) add their own `kind` here and a case in `queue.ts`.
//
// Two layers of message on purpose:
//
//   comment.fanout — one message per comment, enqueued by the request. It
//     carries only the comment's identity, so the request invocation does a
//     single `queue.send()` and no database work for notifications at all.
//     The consumer reads the comment's body from the projection and resolves
//     recipients (mentions, thread participants, per-user preference), then
//     enqueues one leaf message per recipient. The body is deliberately NOT in
//     the message: a comment body may run to 50,000 characters, which does not
//     reliably fit inside one queue message.
//
//   comment.email / comment.digest — the leaves. One message = one email to
//     one person, which is the smallest unit that can be retried and made
//     exactly-once. Each carries the idempotency key the ledger is keyed by.
//
// A duplicate delivery of a `comment.fanout` is deliberately NOT ledgered: it
// just re-enqueues leaves, and every leaf is idempotent, so the re-run sends
// nothing. Ledgering the fan-out would add the one failure mode worth avoiding
// — a fan-out marked "done" whose leaf enqueue never landed.

import type { NotificationEmailPayload } from '../notification-email'

/** Bumped only for a breaking change to a message shape. A consumer that sees
 *  an unknown version acks the message instead of retrying it forever — an old
 *  message in flight during a deploy must not jam the queue. */
export const SIDE_EFFECT_MESSAGE_VERSION = 1

/** Resolve recipients for one comment and enqueue the per-recipient leaves. */
export interface CommentFanoutMessage {
  kind: 'comment.fanout'
  v: number
  projectId: string
  commentId: string
  parentCommentId: string | null
  /** Username of the comment's author (excluded from its own notifications). */
  author: string
  /** SPA base used to build the deep link, captured at enqueue time. */
  baseUrl: string
}

/** Send one comment notification to one recipient. */
export interface CommentEmailMessage {
  kind: 'comment.email'
  v: number
  projectId: string
  commentId: string
  /** `users.id`, stringified — the recipient half of the idempotency key. */
  recipientUserId: string
  recipientUsername: string
  recipientEmail: string
  payload: NotificationEmailPayload
}

/**
 * Send one *thread* digest to one recipient, in place of per-comment mail.
 *
 * Produced only for the recipients past `COMMENT_EMAIL_RECIPIENT_CAP` on a
 * single comment. Keyed per (thread, recipient, UTC day), so a hot thread with
 * a hundred comments still costs each overflow recipient at most one message a
 * day instead of a hundred.
 */
export interface CommentDigestMessage {
  kind: 'comment.digest'
  v: number
  projectId: string
  /** Root comment id of the thread being digested. */
  threadRootId: string
  recipientUserId: string
  recipientUsername: string
  recipientEmail: string
  /** `YYYY-MM-DD` (UTC) — the coalescing window in the idempotency key. */
  dayBucket: string
  projectName: string
  commentsUrl: string
  threadTopic: string
}

export type SideEffectMessage =
  | CommentFanoutMessage
  | CommentEmailMessage
  | CommentDigestMessage

/**
 * The stable idempotency key for one delivery.
 *
 * Built by the producer (not the database) so it survives a queue retry, a
 * duplicate delivery and a redeploy. Namespaced by kind so the side effects
 * that land on this queue later cannot collide in the shared ledger table.
 *
 * `comment.email` is keyed exactly as the ticket specifies —
 * `(commentId, recipientUserId)`.
 */
export function sideEffectIdempotencyKey(message: SideEffectMessage): string | null {
  switch (message.kind) {
    case 'comment.fanout':
      // Not ledgered — see the module comment.
      return null
    case 'comment.email':
      return `comment.email:${message.commentId}:${message.recipientUserId}`
    case 'comment.digest':
      return `comment.digest:${message.threadRootId}:${message.recipientUserId}:${message.dayBucket}`
  }
}

/** UTC day bucket used to coalesce overflow digests. */
export function utcDayBucket(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
