// Tests for the side-effect queue (AQU-1824).
//
// The ticket's acceptance criteria map onto these describes:
//  - a mention still gets its email                      → dispatch + fanout + leaf
//  - a transient provider failure is retried, not lost   → retry/DLQ handling
//  - a message that keeps failing lands in the DLQ       → retry() is called, not ack()
//  - re-delivery does not send a second email            → delivery ledger
//  - a comment past the recipient cap does not fan out   → planCommentEmailLeaves
//  - the comment request no longer sends mail itself     → dispatchCommentNotification

import { describe, it, expect, vi } from 'vitest'
import { makeTestDb } from './helpers/pg-test-db'
import {
  claimDelivery,
  markDelivered,
  markDeliveryFailed,
} from '../side-effects/deliveries'
import {
  COMMENT_EMAIL_RECIPIENT_CAP,
  planCommentEmailLeaves,
  runCommentDigest,
  runCommentEmail,
  runCommentFanout,
} from '../side-effects/comment-email'
import {
  dispatchCommentNotification,
  enqueueSideEffects,
  handleSideEffectBatch,
  type SideEffectQueueEnv,
} from '../side-effects/queue'
import {
  SIDE_EFFECT_MESSAGE_VERSION,
  sideEffectIdempotencyKey,
  utcDayBucket,
  type CommentEmailMessage,
  type SideEffectMessage,
} from '../side-effects/types'
import type { CommentNotificationPlan, EmailService } from '../notification-email'

function makeEmailBinding(impl?: () => Promise<void>) {
  return {
    send: vi.fn(async () => {
      if (impl) await impl()
      return { messageId: 'mid-1' }
    }),
  } as unknown as EmailService & { send: ReturnType<typeof vi.fn> }
}

function makeQueueBinding() {
  const sent: SideEffectMessage[] = []
  return {
    sent,
    binding: {
      send: vi.fn(async (body: SideEffectMessage) => {
        sent.push(body)
      }),
      sendBatch: vi.fn(async (messages: { body: SideEffectMessage }[]) => {
        for (const m of messages) sent.push(m.body)
      }),
    } as unknown as Queue<SideEffectMessage>,
  }
}

/** Seed the comment row the fan-out reads its body from. */
async function seedComment(
  db: AquillaDb,
  opts: { projectId: string; commentId: string; body: string; author?: string },
) {
  await db
    .prepare(
      `INSERT INTO comments
         (comment_id, project_id, scope_kind, body, author_id, created_at, updated_at)
       VALUES (?, ?, 'project', ?, ?, 0, 0)`,
    )
    .bind(opts.commentId, opts.projectId, opts.body, opts.author ?? 'alice')
    .run()
}

function emailMessage(
  over: Partial<CommentEmailMessage> = {},
): CommentEmailMessage {
  return {
    kind: 'comment.email',
    v: SIDE_EFFECT_MESSAGE_VERSION,
    projectId: 'proj-1',
    commentId: 'c-1',
    recipientUserId: '7',
    recipientUsername: 'bob',
    recipientEmail: 'bob@example.com',
    payload: {
      authorDisplayName: 'alice',
      kind: 'mention',
      projectName: 'MyProject',
      excerpt: 'hello @bob',
      commentsUrl: 'https://aquilla.app/project/proj-1/comments',
      threadTopic: 'hello @bob',
      isReply: false,
    },
    ...over,
  }
}

// ── Idempotency keys ─────────────────────────────────────────────────────

describe('sideEffectIdempotencyKey', () => {
  it('keys comment mail by (commentId, recipientUserId) as the ticket specifies', () => {
    expect(sideEffectIdempotencyKey(emailMessage())).toBe('comment.email:c-1:7')
  })

  it('keys a digest per thread, recipient and UTC day', () => {
    expect(
      sideEffectIdempotencyKey({
        kind: 'comment.digest',
        v: SIDE_EFFECT_MESSAGE_VERSION,
        projectId: 'proj-1',
        threadRootId: 'root-9',
        recipientUserId: '7',
        recipientUsername: 'bob',
        recipientEmail: 'bob@example.com',
        dayBucket: '2026-10-10',
        projectName: 'MyProject',
        commentsUrl: 'https://aquilla.app/project/proj-1/comments',
        threadTopic: 'topic',
      }),
    ).toBe('comment.digest:root-9:7:2026-10-10')
  })

  it('does not ledger a fan-out — re-running it only re-enqueues idempotent leaves', () => {
    expect(
      sideEffectIdempotencyKey({
        kind: 'comment.fanout',
        v: SIDE_EFFECT_MESSAGE_VERSION,
        projectId: 'proj-1',
        commentId: 'c-1',
        parentCommentId: null,
        author: 'alice',
        baseUrl: 'https://aquilla.app',
      }),
    ).toBeNull()
  })

  it('buckets by UTC day', () => {
    expect(utcDayBucket(new Date('2026-10-10T23:59:59Z'))).toBe('2026-10-10')
    expect(utcDayBucket(new Date('2026-10-11T00:00:01Z'))).toBe('2026-10-11')
  })
})

// ── Delivery ledger ──────────────────────────────────────────────────────

describe('delivery ledger', () => {
  it('claims a key once, then refuses it after the work is marked done', async () => {
    const { db } = await makeTestDb()
    expect(await claimDelivery(db, 'k-1', 'comment.email')).toBe(true)
    await markDelivered(db, 'k-1')
    expect(await claimDelivery(db, 'k-1', 'comment.email')).toBe(false)
  })

  it('re-claims a failed delivery so a transient provider error still gets retried', async () => {
    const { db } = await makeTestDb()
    expect(await claimDelivery(db, 'k-2', 'comment.email')).toBe(true)
    await markDeliveryFailed(db, 'k-2', new Error('provider down'))
    expect(await claimDelivery(db, 'k-2', 'comment.email')).toBe(true)

    const row = await db
      .prepare('SELECT attempts, status, last_error FROM side_effect_deliveries WHERE idempotency_key = ?')
      .bind('k-2')
      .first<{ attempts: number; status: string; last_error: string }>()
    expect(row?.attempts).toBe(2)
    expect(row?.last_error).toBe('provider down')
  })

  it('never reopens a delivery that already completed', async () => {
    const { db } = await makeTestDb()
    await claimDelivery(db, 'k-3', 'comment.email')
    await markDelivered(db, 'k-3')
    await markDeliveryFailed(db, 'k-3', new Error('late failure report'))
    const row = await db
      .prepare('SELECT status FROM side_effect_deliveries WHERE idempotency_key = ?')
      .bind('k-3')
      .first<{ status: string }>()
    expect(row?.status).toBe('sent')
  })
})

// ── Recipient cap ────────────────────────────────────────────────────────

function planWith(count: number, kind: 'mention' | 'reply' = 'mention'): CommentNotificationPlan {
  return {
    recipients: Array.from({ length: count }, (_, i) => ({
      username: `user${String(i).padStart(3, '0')}`,
      userId: String(i),
      email: `user${i}@example.com`,
      kind,
    })),
    authorDisplayName: 'alice',
    projectName: 'MyProject',
    commentsUrl: 'https://aquilla.app/project/proj-1/comments',
    excerpt: 'big broadcast',
    threadTopic: 'big broadcast',
    isReply: false,
    threadRootId: 'root-1',
  }
}

describe('planCommentEmailLeaves — recipient cap (AQU-1824)', () => {
  it('sends per-comment mail up to the cap and digests the rest', () => {
    const overflow = 10
    const { emails, digests, dropped } = planCommentEmailLeaves({
      plan: planWith(COMMENT_EMAIL_RECIPIENT_CAP + overflow),
      projectId: 'proj-1',
      commentId: 'c-1',
    })
    expect(emails).toHaveLength(COMMENT_EMAIL_RECIPIENT_CAP)
    expect(digests).toHaveLength(overflow)
    expect(dropped).toBe(0)
    // Every leaf is addressed to exactly one person — the unit that can be
    // retried and made exactly-once.
    expect(new Set(emails.map((m) => m.recipientUserId)).size).toBe(emails.length)
  })

  it('leaves a comment under the cap entirely on the per-comment path', () => {
    const { emails, digests } = planCommentEmailLeaves({
      plan: planWith(3),
      projectId: 'proj-1',
      commentId: 'c-1',
    })
    expect(emails).toHaveLength(3)
    expect(digests).toHaveLength(0)
  })

  it('caps reply mail before mention mail, however the plan is ordered', () => {
    // resolveCommentNotificationPlan puts mentions first; this pins that the
    // cap consumes that order, so being @-named is never the mail that drops.
    const mentions = planWith(COMMENT_EMAIL_RECIPIENT_CAP, 'mention').recipients
    const replies = planWith(5, 'reply').recipients.map((r) => ({
      ...r,
      username: `z-${r.username}`,
      userId: `r-${r.userId}`,
    }))
    const { emails, digests } = planCommentEmailLeaves({
      plan: { ...planWith(0), recipients: [...mentions, ...replies] },
      projectId: 'proj-1',
      commentId: 'c-1',
    })
    expect(emails.every((m) => m.payload.kind === 'mention')).toBe(true)
    expect(digests.map((d) => d.recipientUserId)).toEqual(replies.map((r) => r.userId))
  })

  it('drops the overflow rather than fanning out when there is no thread to digest', () => {
    const { emails, digests, dropped } = planCommentEmailLeaves({
      plan: { ...planWith(COMMENT_EMAIL_RECIPIENT_CAP + 4), threadRootId: null },
      projectId: 'proj-1',
      commentId: 'c-1',
    })
    expect(emails).toHaveLength(COMMENT_EMAIL_RECIPIENT_CAP)
    expect(digests).toHaveLength(0)
    expect(dropped).toBe(4)
  })
})

// ── Leaf delivery ────────────────────────────────────────────────────────

describe('runCommentEmail', () => {
  it('delivers the mention email once', async () => {
    const { db } = await makeTestDb()
    const email = makeEmailBinding()
    await runCommentEmail({ AQUILLA_PG: db, EMAIL: email }, emailMessage())

    expect(email.send).toHaveBeenCalledOnce()
    expect(email.send.mock.calls[0][0].to).toEqual(['bob@example.com'])
    expect(email.send.mock.calls[0][0].subject).toBe('[MyProject] hello @bob')
  })

  it('does not send a second email when the same message is delivered again', async () => {
    const { db } = await makeTestDb()
    const email = makeEmailBinding()
    const env = { AQUILLA_PG: db, EMAIL: email }

    await runCommentEmail(env, emailMessage())
    await runCommentEmail(env, emailMessage())
    await runCommentEmail(env, emailMessage())

    expect(email.send).toHaveBeenCalledOnce()
  })

  it('re-throws a provider failure and records it, then delivers once on retry', async () => {
    const { db } = await makeTestDb()
    let fail = true
    const email = makeEmailBinding(async () => {
      if (fail) throw new Error('provider down')
    })
    const env = { AQUILLA_PG: db, EMAIL: email }

    await expect(runCommentEmail(env, emailMessage())).rejects.toThrow(/provider down/)
    const failed = await db
      .prepare('SELECT status, last_error FROM side_effect_deliveries WHERE idempotency_key = ?')
      .bind('comment.email:c-1:7')
      .first<{ status: string; last_error: string }>()
    expect(failed?.status).toBe('failed')
    expect(failed?.last_error).toMatch(/provider down/)

    // Provider recovers; the queue redelivers the message.
    fail = false
    await runCommentEmail(env, emailMessage())
    const sentRow = await db
      .prepare('SELECT status FROM side_effect_deliveries WHERE idempotency_key = ?')
      .bind('comment.email:c-1:7')
      .first<{ status: string }>()
    expect(sentRow?.status).toBe('sent')

    // And a further redelivery after success sends nothing more.
    await runCommentEmail(env, emailMessage())
    expect(email.send).toHaveBeenCalledTimes(2) // the failed attempt + the successful one
  })

  it('no-ops without a mail provider and writes no ledger row', async () => {
    const { db } = await makeTestDb()
    await runCommentEmail({ AQUILLA_PG: db }, emailMessage())
    const row = await db
      .prepare('SELECT count(*)::int AS n FROM side_effect_deliveries')
      .first<{ n: number }>()
    expect(row?.n).toBe(0)
  })
})

describe('runCommentDigest', () => {
  it('sends one digest per (thread, recipient, day) however often it is redelivered', async () => {
    const { db } = await makeTestDb()
    const email = makeEmailBinding()
    const env = { AQUILLA_PG: db, EMAIL: email }
    const message = {
      kind: 'comment.digest' as const,
      v: SIDE_EFFECT_MESSAGE_VERSION,
      projectId: 'proj-1',
      threadRootId: 'root-9',
      recipientUserId: '7',
      recipientUsername: 'bob',
      recipientEmail: 'bob@example.com',
      dayBucket: '2026-10-10',
      projectName: 'MyProject',
      commentsUrl: 'https://aquilla.app/project/proj-1/comments',
      threadTopic: 'a busy thread',
    }

    await runCommentDigest(env, message)
    await runCommentDigest(env, message)
    expect(email.send).toHaveBeenCalledOnce()
    // Shares the thread's subject shape so clients keep one conversation.
    expect(email.send.mock.calls[0][0].subject).toBe('Re: [MyProject] a busy thread')
  })
})

// ── Fan-out ──────────────────────────────────────────────────────────────

describe('runCommentFanout', () => {
  it('resolves recipients from the database and enqueues one leaf each', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'bob', 'bob@example.com', '')")
      .run()
    await db
      .prepare("INSERT INTO projects (id, name, created_by) VALUES ('proj-1', 'MyProject', 1)")
      .run()

    await seedComment(db, {
      projectId: 'proj-1',
      commentId: 'c-1',
      body: 'Hello @[bob], look at this',
    })

    const enqueued: SideEffectMessage[] = []
    await runCommentFanout(
      { AQUILLA_PG: db },
      {
        kind: 'comment.fanout',
        v: SIDE_EFFECT_MESSAGE_VERSION,
        projectId: 'proj-1',
        commentId: 'c-1',
        parentCommentId: null,
        author: 'alice',
        baseUrl: 'https://aquilla.app',
      },
      async (messages) => {
        enqueued.push(...messages)
      },
    )

    expect(enqueued).toHaveLength(1)
    const leaf = enqueued[0] as CommentEmailMessage
    expect(leaf.kind).toBe('comment.email')
    expect(leaf.recipientUsername).toBe('bob')
    expect(leaf.recipientEmail).toBe('bob@example.com')
    expect(leaf.payload.kind).toBe('mention')
    expect(sideEffectIdempotencyKey(leaf)).toBe('comment.email:c-1:1')
  })

  it('enqueues nothing when nobody is eligible', async () => {
    const { db } = await makeTestDb()
    await seedComment(db, { projectId: 'proj-1', commentId: 'c-1', body: 'nobody here' })
    const enqueued: SideEffectMessage[] = []
    await runCommentFanout(
      { AQUILLA_PG: db },
      {
        kind: 'comment.fanout',
        v: SIDE_EFFECT_MESSAGE_VERSION,
        projectId: 'proj-1',
        commentId: 'c-1',
        parentCommentId: null,
        author: 'alice',
        baseUrl: 'https://aquilla.app',
      },
      async (messages) => {
        enqueued.push(...messages)
      },
    )
    expect(enqueued).toEqual([])
  })

  it('notifies nobody, without erroring, when the comment is gone by fan-out time', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'bob', 'bob@example.com', '')")
      .run()
    // No comments row: deleted in the seconds between the write and the
    // fan-out. Retrying cannot bring it back, so this must not throw — a throw
    // would send the message round the retry loop to the DLQ.
    const enqueued: SideEffectMessage[] = []
    await runCommentFanout(
      { AQUILLA_PG: db },
      {
        kind: 'comment.fanout',
        v: SIDE_EFFECT_MESSAGE_VERSION,
        projectId: 'proj-1',
        commentId: 'gone',
        parentCommentId: null,
        author: 'alice',
        baseUrl: 'https://aquilla.app',
      },
      async (messages) => {
        enqueued.push(...messages)
      },
    )
    expect(enqueued).toEqual([])
  })

  it('reads the body from the projection, so a 50k-char comment still fits one message', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'bob', 'bob@example.com', '')")
      .run()
    await db
      .prepare("INSERT INTO projects (id, name, created_by) VALUES ('proj-1', 'MyProject', 1)")
      .run()
    // A body at the spec's 50,000-char ceiling would not reliably fit inside a
    // queue message; the fan-out message carries identity only, so it cannot.
    const huge = `${'\u3042'.repeat(49_980)} @[bob]`
    await seedComment(db, { projectId: 'proj-1', commentId: 'c-big', body: huge })

    const fanout = {
      kind: 'comment.fanout' as const,
      v: SIDE_EFFECT_MESSAGE_VERSION,
      projectId: 'proj-1',
      commentId: 'c-big',
      parentCommentId: null,
      author: 'alice',
      baseUrl: 'https://aquilla.app',
    }
    expect(new TextEncoder().encode(JSON.stringify(fanout)).byteLength).toBeLessThan(1_000)

    const enqueued: SideEffectMessage[] = []
    await runCommentFanout({ AQUILLA_PG: db }, fanout, async (messages) => {
      enqueued.push(...messages)
    })
    expect(enqueued).toHaveLength(1)
    const leaf = enqueued[0] as CommentEmailMessage
    expect(leaf.recipientUsername).toBe('bob')
    // The excerpt is capped, so the leaf message stays small too.
    expect(leaf.payload.excerpt.length).toBeLessThanOrEqual(200)
  })

  it('throws (so the queue retries) when Postgres is not bound', async () => {
    await expect(
      runCommentFanout(
        {},
        {
          kind: 'comment.fanout',
          v: SIDE_EFFECT_MESSAGE_VERSION,
          projectId: 'proj-1',
          commentId: 'c-1',
          parentCommentId: null,
          author: 'alice',
          baseUrl: 'https://aquilla.app',
        },
        async () => {},
      ),
    ).rejects.toThrow(/AQUILLA_PG not bound/)
  })
})

// ── Batch handling (ack / retry / DLQ) ───────────────────────────────────

function makeBatchMessage(body: SideEffectMessage, attempts = 1) {
  return { body, attempts, id: 'm-1', timestamp: new Date(), ack: vi.fn(), retry: vi.fn() }
}

describe('handleSideEffectBatch', () => {
  it('acks a message whose side effect completed', async () => {
    const { db } = await makeTestDb()
    const message = makeBatchMessage(emailMessage())
    await handleSideEffectBatch(
      { messages: [message] } as unknown as MessageBatch<SideEffectMessage>,
      { AQUILLA_PG: db, EMAIL: makeEmailBinding() },
    )
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it('retries a failed message instead of acking it, so it can reach the DLQ', async () => {
    const { db } = await makeTestDb()
    const email = makeEmailBinding(async () => {
      throw new Error('provider down')
    })
    const message = makeBatchMessage(emailMessage(), 5)
    await handleSideEffectBatch(
      { messages: [message] } as unknown as MessageBatch<SideEffectMessage>,
      { AQUILLA_PG: db, EMAIL: email },
    )
    // retry() with the consumer's max_retries exhausted is what moves the
    // message to the dead-letter queue — acking here would lose the email.
    expect(message.retry).toHaveBeenCalledOnce()
    expect(message.ack).not.toHaveBeenCalled()
  })

  it('does not let one poisonous message drag its batch-mates back', async () => {
    const { db } = await makeTestDb()
    const email = makeEmailBinding(async () => {
      if (email.send.mock.calls.length === 1) throw new Error('first one fails')
    })
    const bad = makeBatchMessage(emailMessage({ commentId: 'c-bad' }))
    const good = makeBatchMessage(emailMessage({ commentId: 'c-good' }))
    await handleSideEffectBatch(
      { messages: [bad, good] } as unknown as MessageBatch<SideEffectMessage>,
      { AQUILLA_PG: db, EMAIL: email },
    )
    expect(bad.retry).toHaveBeenCalledOnce()
    expect(good.ack).toHaveBeenCalledOnce()
  })

  it('acks a message from an unknown schema version rather than jamming the queue', async () => {
    const { db } = await makeTestDb()
    const email = makeEmailBinding()
    const message = makeBatchMessage(emailMessage({ v: SIDE_EFFECT_MESSAGE_VERSION + 1 }))
    await handleSideEffectBatch(
      { messages: [message] } as unknown as MessageBatch<SideEffectMessage>,
      { AQUILLA_PG: db, EMAIL: email },
    )
    expect(message.ack).toHaveBeenCalledOnce()
    expect(email.send).not.toHaveBeenCalled()
  })
})

// ── Producer: the comment request stops sending mail itself ──────────────

describe('dispatchCommentNotification', () => {
  it('enqueues one fan-out message and sends no email in the request invocation', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'bob', 'bob@example.com', '')")
      .run()
    const email = makeEmailBinding()
    const queue = makeQueueBinding()

    await dispatchCommentNotification(
      { AQUILLA_PG: db, EMAIL: email, SIDE_EFFECTS: queue.binding },
      {
        baseUrl: 'https://aquilla.app',
        projectId: 'proj-1',
        author: 'alice',
        body: 'Hello @[bob]',
        parentCommentId: null,
        commentId: 'c-1',
      },
    )

    expect(email.send).not.toHaveBeenCalled()
    expect(queue.sent).toEqual([
      {
        kind: 'comment.fanout',
        v: SIDE_EFFECT_MESSAGE_VERSION,
        projectId: 'proj-1',
        commentId: 'c-1',
        parentCommentId: null,
        author: 'alice',
        baseUrl: 'https://aquilla.app',
      },
    ])
  })

  it('sends inline when there is no queue binding (local dev / e2e)', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'bob', 'bob@example.com', '')")
      .run()
    await db
      .prepare("INSERT INTO projects (id, name, created_by) VALUES ('proj-1', 'MyProject', 1)")
      .run()
    const email = makeEmailBinding()

    await dispatchCommentNotification(
      { AQUILLA_PG: db, EMAIL: email },
      {
        baseUrl: 'https://aquilla.app',
        projectId: 'proj-1',
        author: 'alice',
        body: 'Hello @[bob]',
        parentCommentId: null,
        commentId: 'c-1',
      },
    )

    expect(email.send).toHaveBeenCalledOnce()
    expect(email.send.mock.calls[0][0].to).toEqual(['bob@example.com'])
  })

  it('falls back to an inline send when the enqueue itself fails', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'bob', 'bob@example.com', '')")
      .run()
    await db
      .prepare("INSERT INTO projects (id, name, created_by) VALUES ('proj-1', 'MyProject', 1)")
      .run()
    const email = makeEmailBinding()
    const broken = {
      sendBatch: vi.fn(async () => {
        throw new Error('queue unreachable')
      }),
    } as unknown as Queue<SideEffectMessage>

    await dispatchCommentNotification(
      { AQUILLA_PG: db, EMAIL: email, SIDE_EFFECTS: broken },
      {
        baseUrl: 'https://aquilla.app',
        projectId: 'proj-1',
        author: 'alice',
        body: 'Hello @[bob]',
        parentCommentId: null,
        commentId: 'c-1',
      },
    )

    expect(email.send).toHaveBeenCalledOnce()
  })
})

describe('enqueueSideEffects', () => {
  it('reports that it enqueued nothing when the binding is absent', async () => {
    expect(await enqueueSideEffects({}, [emailMessage()])).toBe(false)
  })

  it('chunks a wide fan-out into batches the platform accepts', async () => {
    const queue = makeQueueBinding()
    const env: SideEffectQueueEnv = { SIDE_EFFECTS: queue.binding }
    const messages = Array.from({ length: 250 }, (_, i) =>
      emailMessage({ recipientUserId: String(i) }),
    )
    expect(await enqueueSideEffects(env, messages)).toBe(true)
    expect(
      (queue.binding as unknown as { sendBatch: ReturnType<typeof vi.fn> }).sendBatch,
    ).toHaveBeenCalledTimes(3)
    expect(queue.sent).toHaveLength(250)
  })
})
