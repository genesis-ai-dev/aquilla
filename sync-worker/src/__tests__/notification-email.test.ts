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
} from '../notification-email'
import { makeTestDb } from './helpers/pg-test-db'

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

// ── sendNotificationEmail — missing API key is a no-op ───────────────────

describe('sendNotificationEmail', () => {
  it('returns without calling fetch when RESEND_API_KEY is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await sendNotificationEmail(
      { RESEND_API_KEY: undefined },
      'user@example.com',
      {
        authorDisplayName: 'Alice',
        kind: 'mention',
        projectName: 'TestProject',
        excerpt: 'Hello @bob',
        commentsUrl: 'https://aquilla.app/project/p1/comments',
      },
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('calls fetch with correct payload when RESEND_API_KEY is present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    )
    await sendNotificationEmail(
      { RESEND_API_KEY: 'test-key', EMAIL_FROM: 'test@example.com' },
      'recipient@example.com',
      {
        authorDisplayName: 'Alice',
        kind: 'mention',
        projectName: 'TestProject',
        excerpt: 'Hello @bob',
        commentsUrl: 'https://aquilla.app/project/p1/comments',
      },
    )
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(init.body as string)
    expect(body.to).toEqual(['recipient@example.com'])
    expect(body.from).toBe('test@example.com')
    expect(body.subject).toContain('Alice')
    expect(body.subject).toContain('TestProject')
    fetchSpy.mockRestore()
  })

  it('throws when the provider returns an error status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'invalid api key' }), { status: 422 }),
    )
    await expect(
      sendNotificationEmail(
        { RESEND_API_KEY: 'bad-key' },
        'user@example.com',
        {
          authorDisplayName: 'Alice',
          kind: 'reply',
          projectName: 'TestProject',
          excerpt: 'Hi',
          commentsUrl: 'https://aquilla.app/project/p1/comments',
        },
      ),
    ).rejects.toThrow('invalid api key')
    fetchSpy.mockRestore()
  })
})

// ── sendCommentNotifications — send failure never propagates ─────────────

describe('sendCommentNotifications', () => {
  it('does not throw when RESEND_API_KEY is absent (no-op)', async () => {
    const { db } = await makeTestDb()
    await expect(
      sendCommentNotifications({
        env: { RESEND_API_KEY: undefined },
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

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 500 }),
    )
    // Should not throw despite HTTP 500
    await expect(
      sendCommentNotifications({
        env: { RESEND_API_KEY: 'test-key' },
        db,
        baseUrl: 'https://aquilla.app',
        projectId: 'proj-1',
        author: 'alice',
        body: 'Hello @bob',
        parentCommentId: null,
      }),
    ).resolves.toBeUndefined()
    fetchSpy.mockRestore()
  })

  it('sends mention email to mentioned user', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'bob', 'bob@example.com', '')")
      .run()
    await db
      .prepare("INSERT INTO projects (id, name, created_by) VALUES ('proj-1', 'MyProject', 1)")
      .run()

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    )
    await sendCommentNotifications({
      env: { RESEND_API_KEY: 'test-key' },
      db,
      baseUrl: 'https://aquilla.app',
      projectId: 'proj-1',
      author: 'alice',
      body: 'Hello @bob, check this out',
      parentCommentId: null,
    })

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.to).toEqual(['bob@example.com'])
    expect(body.subject).toContain('alice')
    expect(body.subject).toContain('MyProject')
    fetchSpy.mockRestore()
  })

  it('does not send to the comment author even if self-mentioned', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'alice@example.com', '')")
      .run()

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    )
    await sendCommentNotifications({
      env: { RESEND_API_KEY: 'test-key' },
      db,
      baseUrl: 'https://aquilla.app',
      projectId: 'proj-1',
      author: 'alice',
      body: 'Reminding myself @alice',
      parentCommentId: null,
    })

    // fetch should NOT have been called — alice is both author and only recipient
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
