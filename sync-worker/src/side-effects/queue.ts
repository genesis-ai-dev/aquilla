// The side-effect queue: producer helper + consumer dispatch (AQU-1824).
//
// Binding: `SIDE_EFFECTS` (wrangler.toml, deployed envs only). The consumer
// config there carries `max_retries` and a `dead_letter_queue`, so a message
// that keeps failing stops retrying and becomes visible in the DLQ instead of
// disappearing into a `console.warn`.
//
// The binding is deliberately OPTIONAL. Local `wrangler dev`, the e2e stack
// and the unit suite have no queue, and provisioning one must not be a
// prerequisite for running the app. Without it `enqueueSideEffects` reports
// that it enqueued nothing and the caller runs the side effect inline — the
// pre-queue behaviour, which is correct for a single-developer stack.

import {
  runCommentDigest,
  runCommentEmail,
  runCommentFanout,
  type CommentSideEffectEnv,
} from './comment-email'
import { sendCommentNotifications } from '../notification-email'
import {
  SIDE_EFFECT_MESSAGE_VERSION,
  type SideEffectMessage,
} from './types'

/** Cloudflare's per-`sendBatch` message ceiling. */
const QUEUE_SEND_BATCH_MAX = 100

export interface SideEffectQueueEnv extends CommentSideEffectEnv {
  /** Producer binding for the side-effect queue. Absent locally/e2e. */
  SIDE_EFFECTS?: Queue<SideEffectMessage>
}

/**
 * Enqueue side-effect work.
 *
 * Returns false when there is no queue binding, which is the caller's signal
 * to do the work inline instead. Returns true once every message is accepted;
 * a `sendBatch` rejection propagates, because losing the enqueue silently is
 * the bug this queue exists to fix.
 */
export async function enqueueSideEffects(
  env: SideEffectQueueEnv,
  messages: SideEffectMessage[],
): Promise<boolean> {
  if (!env.SIDE_EFFECTS) return false
  if (messages.length === 0) return true
  for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_MAX) {
    const chunk = messages.slice(i, i + QUEUE_SEND_BATCH_MAX)
    await env.SIDE_EFFECTS.sendBatch(chunk.map((body) => ({ body })))
  }
  return true
}

/**
 * Consumer entry point — one batch of side-effect messages.
 *
 * Per message: ack on success, `retry()` on failure. Each message is acked or
 * retried individually (not via the batch-level helpers) so one poisonous
 * message cannot drag its batch-mates back through work they already did.
 */
export async function handleSideEffectBatch(
  batch: MessageBatch<SideEffectMessage>,
  env: SideEffectQueueEnv,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await dispatchSideEffect(env, message.body)
        message.ack()
      } catch (err) {
        console.warn(
          `[side-effects] ${message.body?.kind ?? 'unknown'} attempt ${message.attempts} failed:`,
          err,
        )
        message.retry()
      }
    }),
  )
}

async function dispatchSideEffect(
  env: SideEffectQueueEnv,
  body: SideEffectMessage,
): Promise<void> {
  // A message from a future (or missing) schema version is acked, not retried:
  // retrying it forever would jam the queue behind something this deployment
  // cannot ever understand. The DLQ is for work that could still succeed.
  if (!body || typeof body.kind !== 'string') {
    console.warn('[side-effects] dropping unreadable message')
    return
  }
  if (body.v !== SIDE_EFFECT_MESSAGE_VERSION) {
    console.warn(
      `[side-effects] dropping ${body.kind} message of version ${body.v} ` +
        `(this worker speaks ${SIDE_EFFECT_MESSAGE_VERSION})`,
    )
    return
  }

  switch (body.kind) {
    case 'comment.fanout':
      await runCommentFanout(env, body, async (messages) => {
        const enqueued = await enqueueSideEffects(env, messages)
        if (!enqueued) {
          // The consumer is running, so the queue exists; a missing producer
          // binding here is a deploy error, not a local-dev shape.
          throw new Error('comment.fanout: SIDE_EFFECTS producer binding missing')
        }
      })
      return
    case 'comment.email':
      await runCommentEmail(env, body)
      return
    case 'comment.digest':
      await runCommentDigest(env, body)
      return
    default: {
      const unknown = body as { kind: string }
      console.warn(`[side-effects] dropping unknown message kind ${unknown.kind}`)
    }
  }
}

// ── Producer entry point for the comment write path ──────────────────────

/**
 * Hand one `comment.create` to the queue (AQU-1824).
 *
 * This is all the comment write path does for notifications now: one
 * `queue.send()`, no recipient resolution and no `EMAIL.send()` inside the
 * request's own invocation.
 *
 * Falls back to sending inline when there is no queue binding (local dev, e2e)
 * or when the enqueue itself fails. The fallback is the pre-queue behaviour —
 * best-effort, no retries — and is strictly better than dropping the
 * notification because the queue was unreachable.
 */
export async function dispatchCommentNotification(
  env: SideEffectQueueEnv,
  opts: {
    baseUrl: string
    projectId: string
    author: string
    body: string
    parentCommentId: string | null
    /** Absent on an older client's payload; without it there is no stable
     *  idempotency key, so such a comment takes the inline path. */
    commentId?: string
  },
): Promise<void> {
  const db = env.AQUILLA_PG
  if (!db) return

  const inline = () =>
    sendCommentNotifications({
      env,
      db,
      baseUrl: opts.baseUrl,
      projectId: opts.projectId,
      author: opts.author,
      body: opts.body,
      parentCommentId: opts.parentCommentId,
      commentId: opts.commentId,
    })

  if (!env.SIDE_EFFECTS || !opts.commentId) {
    await inline()
    return
  }

  try {
    await enqueueSideEffects(env, [
      {
        kind: 'comment.fanout',
        v: SIDE_EFFECT_MESSAGE_VERSION,
        projectId: opts.projectId,
        commentId: opts.commentId,
        parentCommentId: opts.parentCommentId,
        author: opts.author,
        baseUrl: opts.baseUrl,
      },
    ])
  } catch (err) {
    console.warn(
      '[side-effects] enqueue failed for comment notification; sending inline:',
      err,
    )
    await inline()
  }
}
