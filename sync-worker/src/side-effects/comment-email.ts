// Comment / @mention notification mail as side-effect-queue work (AQU-1824).
//
// This is the tracer slice that moves fan-out side effects off
// `ctx.waitUntil` and onto a real queue. Three steps, one message kind each:
//
//   1. the request enqueues one `comment.fanout` (see events/route.ts);
//   2. `runCommentFanout` resolves recipients and enqueues the leaves;
//   3. `runCommentEmail` / `runCommentDigest` each send exactly one email,
//      guarded by the delivery ledger.
//
// Nothing here sends mail inside the request invocation, and every send is
// individually retryable and dead-letterable.

import {
  getCommentBody,
  resolveCommentNotificationPlan,
  sendNotificationEmail,
  sendThreadDigestEmail,
  type CommentNotificationPlan,
  type NotificationEnv,
} from '../notification-email'
import { claimDelivery, markDelivered, markDeliveryFailed } from './deliveries'
import {
  SIDE_EFFECT_MESSAGE_VERSION,
  sideEffectIdempotencyKey,
  utcDayBucket,
  type CommentDigestMessage,
  type CommentEmailMessage,
  type CommentFanoutMessage,
  type SideEffectMessage,
} from './types'

/**
 * How many people get per-comment mail for ONE comment.
 *
 * A comment that @-mentions a 300-member org used to try 300 `EMAIL.send()`
 * calls in a single invocation — past the subrequest ceiling, so the tail
 * silently never went out. Past this cap the extra recipients get a
 * once-a-day thread digest instead (below), which is bounded work per
 * recipient however busy the thread gets.
 *
 * 50 is chosen to sit well under the Workers subrequest budget even though
 * each send is now its own invocation, and because a comment naming more than
 * 50 people is a broadcast, not a conversation — per-comment mail is the wrong
 * shape for it regardless of the platform limits.
 */
export const COMMENT_EMAIL_RECIPIENT_CAP = 50

/**
 * Absolute ceiling on leaf messages enqueued for one comment.
 *
 * The digest path is bounded by project membership, which is already bounded —
 * but "already bounded" is how the pre-queue code justified no limit at all.
 * Past this we enqueue nothing further and log, so one pathological comment
 * cannot flood the queue.
 */
export const COMMENT_EMAIL_MAX_LEAVES = 1_000

export interface CommentEmailLeaves {
  emails: CommentEmailMessage[]
  digests: CommentDigestMessage[]
  /** Recipients past COMMENT_EMAIL_MAX_LEAVES who got nothing. Logged, not silent. */
  dropped: number
}

/**
 * Split a resolved plan into leaf messages: per-comment mail up to the cap,
 * then coalesced thread digests.
 *
 * Pure, so the cap and the mention-first priority are unit-testable without a
 * queue or a database.
 */
export function planCommentEmailLeaves(opts: {
  plan: CommentNotificationPlan
  projectId: string
  commentId: string
  now?: Date
}): CommentEmailLeaves {
  const { plan, projectId, commentId } = opts
  const dayBucket = utcDayBucket(opts.now)
  // `plan.recipients` is mentions-first and alphabetical within each group, so
  // the slice is stable across retries and the cap can only drop reply mail.
  const individual = plan.recipients.slice(0, COMMENT_EMAIL_RECIPIENT_CAP)
  const overflow = plan.recipients.slice(COMMENT_EMAIL_RECIPIENT_CAP)

  const emails: CommentEmailMessage[] = individual.map((recipient) => ({
    kind: 'comment.email',
    v: SIDE_EFFECT_MESSAGE_VERSION,
    projectId,
    commentId,
    recipientUserId: recipient.userId,
    recipientUsername: recipient.username,
    recipientEmail: recipient.email,
    payload: {
      authorDisplayName: plan.authorDisplayName,
      kind: recipient.kind,
      projectName: plan.projectName,
      excerpt: plan.excerpt,
      commentsUrl: plan.commentsUrl,
      threadTopic: plan.threadTopic,
      isReply: plan.isReply,
    },
  }))

  // Without a thread root there is nothing stable to coalesce a digest on, so
  // the overflow is dropped rather than mailed per comment — which is the
  // unbounded fan-out this cap exists to prevent.
  const threadRootId = plan.threadRootId
  const digests: CommentDigestMessage[] = threadRootId
    ? overflow.map((recipient) => ({
        kind: 'comment.digest',
        v: SIDE_EFFECT_MESSAGE_VERSION,
        projectId,
        threadRootId,
        recipientUserId: recipient.userId,
        recipientUsername: recipient.username,
        recipientEmail: recipient.email,
        dayBucket,
        projectName: plan.projectName,
        commentsUrl: plan.commentsUrl,
        threadTopic: plan.threadTopic,
      }))
    : []

  const budget = Math.max(0, COMMENT_EMAIL_MAX_LEAVES - emails.length)
  const keptDigests = digests.slice(0, budget)
  const dropped =
    overflow.length - (threadRootId ? keptDigests.length : 0)

  return { emails, digests: keptDigests, dropped }
}

export interface CommentSideEffectEnv extends NotificationEnv {
  AQUILLA_PG?: AquillaDb
}

/**
 * Step 2 — resolve one comment's recipients and enqueue the leaves.
 *
 * Throws on a database failure so the queue retries the whole fan-out: a
 * fan-out that resolved nobody because Postgres blipped must not be acked.
 * Re-running it is safe — every leaf it produces is idempotent.
 *
 * The body is read from the projection rather than carried in the message (see
 * types.ts). A comment that is gone by the time this runs — deleted in the
 * seconds between the write and the fan-out — notifies nobody and is NOT an
 * error: retrying cannot bring it back, and nobody should get mail about a
 * comment that no longer exists.
 */
export async function runCommentFanout(
  env: CommentSideEffectEnv,
  message: CommentFanoutMessage,
  enqueue: (messages: SideEffectMessage[]) => Promise<void>,
): Promise<void> {
  const db = env.AQUILLA_PG
  if (!db) throw new Error('comment.fanout: AQUILLA_PG not bound')

  const body = await getCommentBody(db, message.projectId, message.commentId)
  if (body === null) {
    console.warn(
      `[side-effects] comment ${message.commentId} is gone; no notifications sent`,
    )
    return
  }

  const plan = await resolveCommentNotificationPlan({
    db,
    baseUrl: message.baseUrl,
    projectId: message.projectId,
    author: message.author,
    body,
    parentCommentId: message.parentCommentId,
    commentId: message.commentId,
  })
  if (!plan) return

  const { emails, digests, dropped } = planCommentEmailLeaves({
    plan,
    projectId: message.projectId,
    commentId: message.commentId,
  })
  if (dropped > 0) {
    console.warn(
      `[side-effects] comment ${message.commentId}: ${dropped} recipient(s) past the ` +
        `${COMMENT_EMAIL_MAX_LEAVES}-leaf ceiling got no notification`,
    )
  }
  await enqueue([...emails, ...digests])
}

/** Step 3a — send one comment notification, exactly once. */
export async function runCommentEmail(
  env: CommentSideEffectEnv,
  message: CommentEmailMessage,
): Promise<void> {
  await withDeliveryLedger(env, message, () =>
    sendNotificationEmail(env, message.recipientEmail, message.payload),
  )
}

/** Step 3b — send one thread digest, at most once per (thread, person, day). */
export async function runCommentDigest(
  env: CommentSideEffectEnv,
  message: CommentDigestMessage,
): Promise<void> {
  await withDeliveryLedger(env, message, () =>
    sendThreadDigestEmail(env, message.recipientEmail, {
      projectName: message.projectName,
      commentsUrl: message.commentsUrl,
      threadTopic: message.threadTopic,
    }),
  )
}

/**
 * Claim → send → mark, around one leaf message.
 *
 * Re-throws a send failure so the caller can `retry()` the message; the ledger
 * row is left `failed` with the provider's error on it either way.
 */
async function withDeliveryLedger(
  env: CommentSideEffectEnv,
  message: CommentEmailMessage | CommentDigestMessage,
  send: () => Promise<void>,
): Promise<void> {
  // No mail provider configured (local dev, e2e): skip without writing a
  // ledger row, so these keys stay claimable if the binding is added later.
  if (!env.EMAIL) return

  const db = env.AQUILLA_PG
  if (!db) throw new Error(`${message.kind}: AQUILLA_PG not bound`)

  const key = sideEffectIdempotencyKey(message)
  if (!key) throw new Error(`${message.kind}: no idempotency key`)

  const claimed = await claimDelivery(db, key, message.kind)
  if (!claimed) return // already delivered — a duplicate delivery, not a failure

  try {
    await send()
  } catch (err) {
    await markDeliveryFailed(db, key, err)
    throw err
  }
  await markDelivered(db, key)
}
