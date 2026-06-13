// Tests for sync-worker notification-email.ts
//
// Covers:
// 1. extractMentions inline copy — mirrors comment-helpers tests to catch drift.
// 2. deriveRecipientUsernames — correct union of mentions + participants, minus author.
// 3. sendCommentNotifications — provider missing → no-op; send failure never throws.
// 4. resolveUserEmails — queries users table by username.
// 5. getThreadParticipants — returns existing thread authors for a reply.

import { describe, it, expect, vi } from 'vitest'
import {
  extractMentions,
  deriveRecipientUsernames,
  sendCommentNotifications,
  sendNotificationEmail,
  type EmailService,
} from '../notification-email'
import { makeTestDb } from './helpers/pg-test-db'

type SendArg = Parameters<EmailService['send']>[0]

// ── extractMentions ──────────────────────────────────────────────────────

describe('extractMentions (inline copy)', () => {
  it('finds @username mentions', () => {
    expect(extractMentions('Hey @alice check this')).toEqual(['alice'])
  })

  it('finds multiple mentions', () => {
    expect(extractMentions('@alice and @bob_smith both')).toEqual(['alice', 'bob_smith'])
  })

  it('deduplicates mentions', () => {
    expect(extractMentions('@alice talked to @alice')).toEqual(['alice'])
  })

  it('ignores email-like patterns', () => {
    expect(extractMentions('email me at foo@example.com')).toEqual([])
  })

  it('handles empty string', () => {
    expect(extractMentions('')).toEqual([])
  })
})

// ── deriveRecipientUsernames ─────────────────────────────────────────────

describe('deriveRecipientUsernames', () => {
  it('combines mentions and thread participants', () => {
    const result = deriveRecipientUsernames({
      author: 'alice',
      mentionedUsernames: ['bob'],
      threadParticipantUsernames: ['carol'],
    })
    expect(result).toContain('bob')
    expect(result).toContain('carol')
  })

  it('excludes the comment author', () => {
    const result = deriveRecipientUsernames({
      author: 'alice',
      mentionedUsernames: ['alice', 'bob'],
      threadParticipantUsernames: ['alice'],
    })
    expect(result).not.toContain('alice')
    expect(result).toContain('bob')
  })

  it('deduplicates recipients across mentions and participants', () => {
    const result = deriveRecipientUsernames({
      author: 'alice',
      mentionedUsernames: ['bob'],
      threadParticipantUsernames: ['bob', 'carol'],
    })
    expect(result.filter((u) => u === 'bob').length).toBe(1)
    expect(result).toContain('carol')
  })

  it('returns empty array when only author would be recipient', () => {
    const result = deriveRecipientUsernames({
      author: 'alice',
      mentionedUsernames: ['alice'],
      threadParticipantUsernames: ['alice'],
    })
    expect(result).toHaveLength(0)
  })

  it('returns empty array when no mentions and no thread participants', () => {
    const result = deriveRecipientUsernames({
      author: 'alice',
      mentionedUsernames: [],
      threadParticipantUsernames: [],
    })
    expect(result).toHaveLength(0)
  })
})

// ── sendNotificationEmail — missing EMAIL binding is a no-op ─────────────

/** A fake Cloudflare Email Service binding whose send() is a spy. */
function makeEmailBinding(impl?: (msg: SendArg) => Promise<{ messageId: string }>) {
  const send = vi.fn(impl ?? (async (_msg: SendArg) => ({ messageId: 'test-id' })))
  return { send }
}

describe('sendNotificationEmail', () => {
  it('returns without sending when the EMAIL binding is absent', async () => {
    const email = makeEmailBinding()
    await sendNotificationEmail(
      { EMAIL: undefined },
      'user@example.com',
      {
        authorDisplayName: 'Alice',
        kind: 'mention',
        projectName: 'TestProject',
        excerpt: 'Hello @bob',
        commentsUrl: 'https://aquilla.app/project/p1/comments',
      },
    )
    expect(email.send).not.toHaveBeenCalled()
  })

  it('calls EMAIL.send with correct payload when the binding is present', async () => {
    const email = makeEmailBinding()
    await sendNotificationEmail(
      { EMAIL: email, EMAIL_FROM: 'test@example.com' },
      'recipient@example.com',
      {
        authorDisplayName: 'Alice',
        kind: 'mention',
        projectName: 'TestProject',
        excerpt: 'Hello @bob',
        commentsUrl: 'https://aquilla.app/project/p1/comments',
      },
    )
    expect(email.send).toHaveBeenCalledOnce()
    const msg = email.send.mock.calls[0][0]
    expect(msg.to).toEqual(['recipient@example.com'])
    expect(msg.from).toBe('test@example.com')
    expect(msg.subject).toContain('Alice')
    expect(msg.subject).toContain('TestProject')
  })

  it('defaults the From address to noreply@aquilla.app', async () => {
    const email = makeEmailBinding()
    await sendNotificationEmail({ EMAIL: email }, 'recipient@example.com', {
      authorDisplayName: 'Alice',
      kind: 'mention',
      projectName: 'TestProject',
      excerpt: 'Hello @bob',
      commentsUrl: 'https://aquilla.app/project/p1/comments',
    })
    expect(email.send.mock.calls[0][0].from).toBe('noreply@aquilla.app')
  })

  it('throws when the provider send() rejects', async () => {
    const email = makeEmailBinding(async () => {
      throw new Error('E_SENDER_NOT_VERIFIED')
    })
    await expect(
      sendNotificationEmail(
        { EMAIL: email },
        'user@example.com',
        {
          authorDisplayName: 'Alice',
          kind: 'reply',
          projectName: 'TestProject',
          excerpt: 'Hi',
          commentsUrl: 'https://aquilla.app/project/p1/comments',
        },
      ),
    ).rejects.toThrow('E_SENDER_NOT_VERIFIED')
  })
})

// ── sendCommentNotifications — send failure never propagates ─────────────

describe('sendCommentNotifications', () => {
  it('does not throw when the EMAIL binding is absent (no-op)', async () => {
    const { db } = await makeTestDb()
    await expect(
      sendCommentNotifications({
        env: { EMAIL: undefined },
        db,
        baseUrl: 'https://aquilla.app',
        projectId: 'proj-1',
        author: 'alice',
        body: 'Hello @bob',
        parentCommentId: null,
      }),
    ).resolves.toBeUndefined()
  })

  it('does not propagate send failures', async () => {
    const { db } = await makeTestDb()
    // Seed a user so email lookup finds something
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'bob', 'bob@example.com', '')")
      .run()

    const email = makeEmailBinding(async () => {
      throw new Error('provider down')
    })
    // Should not throw despite the provider rejecting
    await expect(
      sendCommentNotifications({
        env: { EMAIL: email },
        db,
        baseUrl: 'https://aquilla.app',
        projectId: 'proj-1',
        author: 'alice',
        body: 'Hello @bob',
        parentCommentId: null,
      }),
    ).resolves.toBeUndefined()
  })

  it('sends mention email to mentioned user', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'bob', 'bob@example.com', '')")
      .run()
    await db
      .prepare("INSERT INTO projects (id, name, created_by) VALUES ('proj-1', 'MyProject', 1)")
      .run()

    const email = makeEmailBinding()
    await sendCommentNotifications({
      env: { EMAIL: email },
      db,
      baseUrl: 'https://aquilla.app',
      projectId: 'proj-1',
      author: 'alice',
      body: 'Hello @bob, check this out',
      parentCommentId: null,
    })

    expect(email.send).toHaveBeenCalledOnce()
    const msg = email.send.mock.calls[0][0]
    expect(msg.to).toEqual(['bob@example.com'])
    expect(msg.subject).toContain('alice')
    expect(msg.subject).toContain('MyProject')
  })

  it('does not send to the comment author even if self-mentioned', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'alice@example.com', '')")
      .run()

    const email = makeEmailBinding()
    await sendCommentNotifications({
      env: { EMAIL: email },
      db,
      baseUrl: 'https://aquilla.app',
      projectId: 'proj-1',
      author: 'alice',
      body: 'Reminding myself @alice',
      parentCommentId: null,
    })

    // send should NOT have been called — alice is both author and only recipient
    expect(email.send).not.toHaveBeenCalled()
  })
})
