// Tests for sync-worker notification-email.ts
//
// Covers:
// 1. extractMentions inline copy — mirrors comment-helpers tests to catch drift.
// 2. deriveRecipientUsernames — correct union of mentions + participants, minus author.
// 3. sendCommentNotifications — provider missing → no-op; send failure never throws.
// 4. resolveRecipientProfiles — queries users table by username (email + preference).
// 5. getThreadParticipants — returns existing thread authors for a reply.
// 6. AQU-1193 — mention-only default, per-user preference, thread-stable subject.

import { describe, it, expect, vi } from 'vitest'
import {
  extractMentions,
  deriveRecipientUsernames,
  sendCommentNotifications,
  sendNotificationEmail,
  parseCommentEmailPreference,
  shouldEmailRecipient,
  threadSubject,
  threadTopicFromBody,
  resolveRecipientProfiles,
  DEFAULT_COMMENT_EMAIL_PREFERENCE,
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
        threadTopic: 'Hello @bob',
        isReply: false,
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
        threadTopic: 'Hello @bob',
        isReply: false,
      },
    )
    expect(email.send).toHaveBeenCalledOnce()
    const msg = email.send.mock.calls[0][0]
    expect(msg.to).toEqual(['recipient@example.com'])
    expect(msg.from).toBe('test@example.com')
    // AQU-1193: the subject is now the thread's, not the author's — so every
    // message on one thread collapses into one mail conversation.
    expect(msg.subject).toBe('[TestProject] Hello @bob')
  })

  it('defaults the From address to noreply@support.aquilla.app', async () => {
    const email = makeEmailBinding()
    await sendNotificationEmail({ EMAIL: email }, 'recipient@example.com', {
      authorDisplayName: 'Alice',
      kind: 'mention',
      projectName: 'TestProject',
      excerpt: 'Hello @bob',
      commentsUrl: 'https://aquilla.app/project/p1/comments',
      threadTopic: 'Hello @bob',
      isReply: false,
    })
    expect(email.send.mock.calls[0][0].from).toBe('noreply@support.aquilla.app')
  })

  // AQU pen-test finding (2026-07-29): authorDisplayName/projectName/excerpt
  // are attacker-controlled (registration puts no charset limit on username;
  // a comment body is free text) and used to be interpolated into the email
  // HTML unescaped — a crafted username or comment could inject markup
  // (phishing links, spoofed styling, tracking pixels) into a notification
  // sent to a different user's inbox.
  it('HTML-escapes attacker-controlled fields before building the email', async () => {
    const email = makeEmailBinding()
    await sendNotificationEmail(
      { EMAIL: email, EMAIL_FROM: 'test@example.com' },
      'recipient@example.com',
      {
        authorDisplayName: '<img src=x onerror=alert(1)>',
        kind: 'mention',
        projectName: '<script>alert(2)</script>',
        excerpt: 'check this <b>bold</b> & "quoted"',
        commentsUrl: 'https://aquilla.app/project/p1/comments',
        threadTopic: 'check this thread',
        isReply: false,
      },
    )
    const msg = email.send.mock.calls[0][0]
    expect(msg.html).not.toContain('<img')
    expect(msg.html).not.toContain('<script>')
    expect(msg.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(msg.html).toContain('&lt;script&gt;')
    expect(msg.html).toContain('&amp;')
  })

  it("strips CR/LF from subject so a crafted display name can't inject headers", async () => {
    const email = makeEmailBinding()
    await sendNotificationEmail(
      { EMAIL: email },
      'recipient@example.com',
      {
        authorDisplayName: 'Alice',
        kind: 'mention',
        // AQU-1193 moved the interpolated parts of the subject: the project
        // name and the thread topic (a comment body) are what land there now,
        // and both are attacker-influenced.
        projectName: 'TestProject\r\nBcc: attacker@evil.example',
        excerpt: 'hi',
        commentsUrl: 'https://aquilla.app/project/p1/comments',
        threadTopic: 'topic\r\nBcc: other@evil.example',
        isReply: false,
      },
    )
    const msg = email.send.mock.calls[0][0]
    expect(msg.subject).not.toMatch(/[\r\n]/)
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
          threadTopic: 'Hi',
          isReply: true,
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
    expect(msg.subject).toBe('[MyProject] Hello @bob, check this out')
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


// ── AQU-1193: mention-only default, per-user preference, thread clustering ──

describe('parseCommentEmailPreference', () => {
  it('defaults when the blob is null, empty, or unparseable', () => {
    expect(parseCommentEmailPreference(null)).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
    expect(parseCommentEmailPreference(undefined)).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
    expect(parseCommentEmailPreference('')).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
    expect(parseCommentEmailPreference('{not json')).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
  })

  it('defaults when the blob is valid JSON but not an object', () => {
    expect(parseCommentEmailPreference('null')).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
    expect(parseCommentEmailPreference('"mentions"')).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
    expect(parseCommentEmailPreference('42')).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
  })

  it('defaults when the key is missing or holds an unrecognised value', () => {
    expect(parseCommentEmailPreference('{}')).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
    expect(parseCommentEmailPreference('{"theme":"dark"}')).toBe(DEFAULT_COMMENT_EMAIL_PREFERENCE)
    expect(parseCommentEmailPreference('{"commentEmails":"loud"}')).toBe(
      DEFAULT_COMMENT_EMAIL_PREFERENCE,
    )
    expect(parseCommentEmailPreference('{"commentEmails":true}')).toBe(
      DEFAULT_COMMENT_EMAIL_PREFERENCE,
    )
  })

  it('reads each recognised value', () => {
    expect(parseCommentEmailPreference('{"commentEmails":"all"}')).toBe('all')
    expect(parseCommentEmailPreference('{"commentEmails":"mentions"}')).toBe('mentions')
    expect(parseCommentEmailPreference('{"commentEmails":"off"}')).toBe('off')
  })

  it('is mention-only by default', () => {
    expect(DEFAULT_COMMENT_EMAIL_PREFERENCE).toBe('mentions')
  })
})

describe('shouldEmailRecipient', () => {
  it('never sends anything when the user turned email off', () => {
    expect(shouldEmailRecipient('mention', 'off')).toBe(false)
    expect(shouldEmailRecipient('reply', 'off')).toBe(false)
  })

  it('always sends a mention short of off', () => {
    expect(shouldEmailRecipient('mention', 'mentions')).toBe(true)
    expect(shouldEmailRecipient('mention', 'all')).toBe(true)
  })

  it('suppresses reply noise on the default, and keeps it on all', () => {
    expect(shouldEmailRecipient('reply', 'mentions')).toBe(false)
    expect(shouldEmailRecipient('reply', 'all')).toBe(true)
  })
})

describe('threadTopicFromBody', () => {
  it('flattens newlines so the topic is one subject line', () => {
    expect(threadTopicFromBody('first line\nsecond   line')).toBe('first line second line')
  })

  it('falls back to a fixed phrase for an empty or blank body', () => {
    expect(threadTopicFromBody('')).toBe('Comment thread')
    expect(threadTopicFromBody('   \n  ')).toBe('Comment thread')
  })

  it('ellipsises a long body rather than emitting a giant subject', () => {
    const topic = threadTopicFromBody('x'.repeat(200))
    expect(topic).toHaveLength(60)
    expect(topic.endsWith('\u2026')).toBe(true)
  })
})

describe('threadSubject', () => {
  const base = {
    authorDisplayName: 'alice',
    kind: 'mention' as const,
    projectName: 'Luke NT',
    excerpt: 'hi',
    commentsUrl: 'https://aquilla.app/project/p1/comments',
    threadTopic: 'Is this verse right?',
  }

  it('is identical (modulo Re:) for the root and every reply on one thread', () => {
    const root = threadSubject({ ...base, isReply: false })
    const reply = threadSubject({ ...base, kind: 'reply', isReply: true })
    expect(root).toBe('[Luke NT] Is this verse right?')
    expect(reply).toBe('Re: [Luke NT] Is this verse right?')
    expect(reply.replace(/^Re: /, '')).toBe(root)
  })

  it('does not vary with the author — that is what broke grouping before', () => {
    const fromAlice = threadSubject({ ...base, authorDisplayName: 'alice', isReply: true })
    const fromBob = threadSubject({ ...base, authorDisplayName: 'bob', isReply: true })
    expect(fromAlice).toBe(fromBob)
  })

  it('falls back to a topic when the thread topic is blank', () => {
    expect(threadSubject({ ...base, threadTopic: '', isReply: false })).toBe(
      '[Luke NT] Comment thread',
    )
  })
})

describe('resolveRecipientProfiles', () => {
  it('returns email + parsed preference, and defaults an untouched blob', async () => {
    const { db } = await makeTestDb()
    await db
      .prepare(
        "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (1, 'bob', 'bob@example.com', '', '{\"commentEmails\":\"all\"}')",
      )
      .run()
    await db
      .prepare(
        "INSERT INTO users (id, username, email, password_hash) VALUES (2, 'carol', 'carol@example.com', '')",
      )
      .run()

    const profiles = await resolveRecipientProfiles(db, ['bob', 'carol', 'nobody'])
    expect(profiles.get('bob')).toEqual({ email: 'bob@example.com', preference: 'all' })
    expect(profiles.get('carol')).toEqual({
      email: 'carol@example.com',
      preference: 'mentions',
    })
    expect(profiles.has('nobody')).toBe(false)
  })

  it('returns an empty map for no usernames', async () => {
    const { db } = await makeTestDb()
    expect((await resolveRecipientProfiles(db, [])).size).toBe(0)
  })
})

describe('sendCommentNotifications — preference gating (AQU-1193)', () => {
  /** The thread's root comment body. Bound as a parameter, never inlined: the
   *  Postgres shim rewrites `?` to `$n`, and this sentence ends in one. */
  const ROOT_BODY = 'What should we do with verse 4?'

  /** Seed a project plus a root comment with one prior participant (bob). */
  async function seedThread(db: AquillaDb, opts: { bobPreferences?: string } = {}) {
    await db
      .prepare(
        `INSERT INTO users (id, username, email, password_hash, preferences)
         VALUES (1, 'bob', 'bob@example.com', '', ?)`,
      )
      .bind(opts.bobPreferences ?? '{}')
      .run()
    await db
      .prepare("INSERT INTO projects (id, name, created_by) VALUES ('proj-1', 'MyProject', 1)")
      .run()
    await db
      .prepare(
        `INSERT INTO comments
           (comment_id, project_id, scope_kind, body, author_id, created_at, updated_at)
         VALUES ('root-1', 'proj-1', 'project', ?, 'bob', 1, 1)`,
      )
      .bind(ROOT_BODY)
      .run()
  }

  it('does NOT email an unmentioned thread participant by default', async () => {
    const { db } = await makeTestDb()
    await seedThread(db)
    const email = makeEmailBinding()

    await sendCommentNotifications({
      env: { EMAIL: email },
      db,
      baseUrl: 'https://aquilla.app',
      projectId: 'proj-1',
      author: 'alice',
      body: 'I agree with that',
      parentCommentId: 'root-1',
      commentId: 'reply-1',
    })

    expect(email.send).not.toHaveBeenCalled()
  })

  it('emails an unmentioned thread participant who opted into all', async () => {
    const { db } = await makeTestDb()
    await seedThread(db, { bobPreferences: '{"commentEmails":"all"}' })
    const email = makeEmailBinding()

    await sendCommentNotifications({
      env: { EMAIL: email },
      db,
      baseUrl: 'https://aquilla.app',
      projectId: 'proj-1',
      author: 'alice',
      body: 'I agree with that',
      parentCommentId: 'root-1',
      commentId: 'reply-1',
    })

    expect(email.send).toHaveBeenCalledOnce()
  })

  it('still emails a mentioned user who is on the mentions default', async () => {
    const { db } = await makeTestDb()
    await seedThread(db)
    const email = makeEmailBinding()

    await sendCommentNotifications({
      env: { EMAIL: email },
      db,
      baseUrl: 'https://aquilla.app',
      projectId: 'proj-1',
      author: 'alice',
      body: 'what do you think @bob?',
      parentCommentId: 'root-1',
      commentId: 'reply-1',
    })

    expect(email.send).toHaveBeenCalledOnce()
  })

  it('sends nothing at all to a user who turned comment email off, even on a mention', async () => {
    const { db } = await makeTestDb()
    await seedThread(db, { bobPreferences: '{"commentEmails":"off"}' })
    const email = makeEmailBinding()

    await sendCommentNotifications({
      env: { EMAIL: email },
      db,
      baseUrl: 'https://aquilla.app',
      projectId: 'proj-1',
      author: 'alice',
      body: 'what do you think @bob?',
      parentCommentId: 'root-1',
      commentId: 'reply-1',
    })

    expect(email.send).not.toHaveBeenCalled()
  })

  it('subjects a reply from the thread ROOT, so the whole thread is one conversation', async () => {
    const { db } = await makeTestDb()
    await seedThread(db, { bobPreferences: '{"commentEmails":"all"}' })
    const email = makeEmailBinding()

    await sendCommentNotifications({
      env: { EMAIL: email },
      db,
      baseUrl: 'https://aquilla.app',
      projectId: 'proj-1',
      author: 'alice',
      body: 'I agree with that',
      parentCommentId: 'root-1',
      commentId: 'reply-1',
    })

    const msg = email.send.mock.calls[0][0]
    // Root body, not this reply's body — the two replies below would otherwise
    // carry different subjects and land as separate messages.
    expect(msg.subject).toBe(`Re: [MyProject] ${ROOT_BODY}`)
  })

  it('gives two different repliers on one thread the identical subject', async () => {
    const { db } = await makeTestDb()
    await seedThread(db, { bobPreferences: '{"commentEmails":"all"}' })
    const email = makeEmailBinding()

    for (const [author, body] of [
      ['alice', 'first reply'],
      ['carol', 'second reply'],
    ]) {
      await sendCommentNotifications({
        env: { EMAIL: email },
        db,
        baseUrl: 'https://aquilla.app',
        projectId: 'proj-1',
        author,
        body,
        parentCommentId: 'root-1',
        commentId: `reply-${author}`,
      })
    }

    expect(email.send).toHaveBeenCalledTimes(2)
    const subjects = email.send.mock.calls.map((c) => c[0].subject)
    expect(new Set(subjects).size).toBe(1)
  })
})
