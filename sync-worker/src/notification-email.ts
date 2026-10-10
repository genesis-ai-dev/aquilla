// Best-effort comment notification emails for sync-worker.
//
// AQU-1193: comment mail is mention-only by default and thread-clustered. The
// per-user dial lives in `users.preferences.commentEmails` ('all' | 'mentions'
// | 'off'); see CommentEmailPreference below, and the SPA's mirror in
// src/lib/notifications/comment-email-pref.ts.
//
// This module mirrors the NotificationEmailPayload + sendNotificationEmail
// shape from auth-worker/src/services/email.ts. It exists as a separate
// file because sync-worker and auth-worker are distinct CF Workers and
// cannot share source modules at runtime; the two files must stay in sync
// on the NotificationEmailPayload shape.
//
// Outbound mail goes through the Cloudflare Email Service `send_email` binding
// (env.EMAIL.send(), public beta 2026-04) — same provider as auth-worker. The
// binding is declared only in deployed env blocks (wrangler.toml); locally and
// in e2e it is absent, so sends no-op. The sending domain (EMAIL_FROM) must be
// onboarded under Compute > Email Service > Email Sending or sends fail with
// E_SENDER_NOT_VERIFIED.
//
// extractMentions is inlined here (duplicated from src/lib/comments/comment-helpers.ts)
// to avoid a cross-package import that violates the SPA↔worker boundary.
// KEEP IN SYNC with src/lib/comments/comment-helpers.ts extractMentions.

import { ROLE } from './events/role-policy'

/**
 * Stored form of a confirmed mention. The brackets delimit the username, so
 * the capture takes anything a roster username can hold (`qa-bot-2`,
 * `john.doe`); only brackets and line breaks are excluded. Typed `@name` is
 * plain text and never matches.
 * KEEP IN SYNC with src/lib/comments/comment-helpers.ts MENTION_TOKEN_SOURCE.
 */
const MENTION_TOKEN_SOURCE = String.raw`@\[([^\[\]\r\n]+)\]`

/**
 * Extract @username mentions from a comment body.
 * Mirrors src/lib/comments/comment-helpers.ts extractMentions — keep in sync.
 */
export function extractMentions(text: string): string[] {
  const mentions = new Set<string>()
  const re = new RegExp(MENTION_TOKEN_SOURCE, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    mentions.add(match[1])
  }
  return Array.from(mentions)
}

/** Show a confirmed mention as @name in plain-text mail. */
export function mentionDisplayText(text: string): string {
  return text.replace(new RegExp(MENTION_TOKEN_SOURCE, 'g'), '@$1')
}

export interface NotificationEmailPayload {
  /** Display name of the person who posted the comment. */
  authorDisplayName: string
  /** Notification kind — controls headline copy. */
  kind: 'mention' | 'reply'
  /** Project display name. */
  projectName: string
  /** Plain-text excerpt of the comment body (≤200 chars). */
  excerpt: string
  /** Deep link to the project's comments page. */
  commentsUrl: string
  /**
   * Stable topic for the comment THREAD this message belongs to (AQU-1193) —
   * derived from the thread's root comment, so every message in the thread
   * produces the same subject and mail clients collapse them into one
   * conversation. See `threadSubject()`.
   */
  threadTopic: string
  /** True for a reply (not the thread's first message) — prefixes `Re: `. */
  isReply: boolean
}

/**
 * Minimal surface of the Cloudflare Email Service `send_email` binding
 * (public beta 2026-04) — the object-form `send()` we call. Hand-typed
 * because the pinned @cloudflare/workers-types predates Email Service.
 * Mirrors auth-worker/src/types.ts EmailService.
 */
export interface EmailService {
  send(message: {
    from: string
    to: string[]
    subject: string
    html?: string
    text?: string
  }): Promise<{ messageId: string }>
}

export interface NotificationEnv {
  EMAIL?: EmailService
  EMAIL_FROM?: string
}

/** Escape user-controlled strings (display name / project name / comment
 *  excerpt) before interpolating them into notification-email HTML — a
 *  username or comment body is attacker-influenced. Mirrors
 *  auth-worker/src/services/email.ts escapeHtml — keep in sync. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildNotificationHtml(p: NotificationEmailPayload): string {
  const authorDisplayName = escapeHtml(p.authorDisplayName)
  const projectName = escapeHtml(p.projectName)
  const headline =
    p.kind === 'mention'
      ? `${authorDisplayName} mentioned you in <strong>${projectName}</strong>`
      : `${authorDisplayName} replied to a thread in <strong>${projectName}</strong>`
  const truncated = escapeHtml(
    p.excerpt.length > 200 ? p.excerpt.slice(0, 197) + '…' : p.excerpt,
  )
  return `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <p>${headline}:</p>
          <blockquote style="border-left: 3px solid #e5e7eb; padding-left: 12px; color: #374151; margin: 12px 0;">
            ${truncated}
          </blockquote>
          <p style="margin: 20px 0; text-align: center;">
            <a href="${p.commentsUrl}"
               style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">
              View comment
            </a>
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #6b7280; font-size: 0.875rem;">
            ${
              p.kind === 'mention'
                ? 'You are receiving this because you were mentioned in this thread.'
                : 'You are receiving this because you asked for every reply on threads you are part of.'
            }
            Change or turn off comment email under Preferences → Notifications.
          </p>
        </div>
      </body>
    </html>
  `.trim()
}

/** Longest thread topic carried in a subject line before it is ellipsised. */
const MAX_THREAD_TOPIC_CHARS = 60

/**
 * Collapse a comment body to a one-line subject topic (AQU-1193).
 *
 * Newlines are flattened (a subject is a single header line) and the result is
 * capped, so a long opening comment doesn't produce an unreadable subject. An
 * empty or whitespace-only root body falls back to a fixed phrase rather than
 * an empty topic — an empty subject would defeat the grouping this exists for.
 */
export function threadTopicFromBody(body: string): string {
  // A stored mention reads `@name` in the subject, as it does in the excerpt.
  const flattened = mentionDisplayText(body).replace(/\s+/g, ' ').trim()
  if (!flattened) return 'Comment thread'
  return flattened.length > MAX_THREAD_TOPIC_CHARS
    ? flattened.slice(0, MAX_THREAD_TOPIC_CHARS - 1) + '\u2026'
    : flattened
}

/**
 * The subject line for one notification (AQU-1193).
 *
 * Every message about the same comment thread gets the SAME subject, modulo a
 * leading `Re: ` on replies — which is exactly the shape Gmail, Outlook and
 * Apple Mail normalise away when they decide two messages belong to one
 * conversation. Before this, a mention read `{author} mentioned you in {project}`
 * and a reply read `New reply in {project}`, so N replies from N people on one
 * thread arrived as N unrelated messages (the Biblica ETT inbox flood).
 *
 * Threading by subject is a deliberate second choice. Real RFC 5322 threading
 * (`Message-ID` + `In-Reply-To` + `References`) is more reliable, but the
 * Cloudflare Email Service `send_email` binding exposes no custom-header field
 * — see the `EmailService` shape above, which is the whole surface we get.
 * Switch to headers if the binding ever grows them; the thread identity needed
 * to build them (the root comment id) is already resolved by the caller.
 *
 * CR/LF is stripped from every interpolated part: a display name, project name
 * and comment body are all attacker-influenced, and a newline in a subject is a
 * header-injection primitive.
 */
export function threadSubject(payload: NotificationEmailPayload): string {
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ')
  const project = oneLine(payload.projectName)
  const topic = oneLine(payload.threadTopic) || 'Comment thread'
  const base = `[${project}] ${topic}`
  return payload.isReply ? `Re: ${base}` : base
}

/**
 * Send one notification email (fire-and-forget safe — caller uses waitUntil).
 * No-ops when the EMAIL binding is absent (local/e2e) so dev/test never require
 * email config. Throws on provider error so the caller can log failures without
 * blocking the comment write.
 */
export async function sendNotificationEmail(
  env: NotificationEnv,
  toEmail: string,
  payload: NotificationEmailPayload,
): Promise<void> {
  if (!env.EMAIL) return
  const from = env.EMAIL_FROM ?? 'noreply@support.aquilla.app'
  const subject = threadSubject(payload)
  const html = buildNotificationHtml(payload)
  const text =
    payload.kind === 'mention'
      ? `${payload.authorDisplayName} mentioned you in ${payload.projectName}.\n\n${payload.excerpt}\n\nView: ${payload.commentsUrl}`
      : `${payload.authorDisplayName} replied in ${payload.projectName}.\n\n${payload.excerpt}\n\nView: ${payload.commentsUrl}`

  try {
    await env.EMAIL.send({ from, to: [toEmail], subject, html, text })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to send notification email: ${message}`)
  }
}

// ── Recipient resolution ──────────────────────────────────────────────────

/**
 * Derive notification recipients for a comment.create event.
 *
 * Recipients = mentions + thread-participants (all prior authors in same
 * parentCommentId chain, i.e. the root thread) minus the comment author.
 * Returned as a de-duped array of usernames.
 */
export function deriveRecipientUsernames(opts: {
  author: string
  mentionedUsernames: string[]
  threadParticipantUsernames: string[]
}): string[] {
  const recipients = new Set<string>([
    ...opts.mentionedUsernames,
    ...opts.threadParticipantUsernames,
  ])
  recipients.delete(opts.author)
  return Array.from(recipients)
}

// ── Per-user email preference (AQU-1193) ──────────────────────────────

/**
 * How much comment email one user wants.
 *
 * - `all`      — every mention AND every reply on a thread they are in (the
 *                behaviour everyone got before this ticket).
 * - `mentions` — only comments that @-mention them. THE DEFAULT.
 * - `off`      — no comment email at all.
 */
export type CommentEmailPreference = 'all' | 'mentions' | 'off'

/**
 * Mention-only is the default because firing on every reply is what flooded
 * inboxes during the 2026-09-04 Biblica ETT test: several people replying on
 * one cell sent each participant a separate message per reply. Catherine's ask
 * was literally "the only time you get a notification is if someone @-mentions
 * you". Someone who wants the old firehose opts into `all`.
 */
export const DEFAULT_COMMENT_EMAIL_PREFERENCE: CommentEmailPreference = 'mentions'

/** Key this preference lives under inside the `users.preferences` JSON blob.
 *  MIRRORED in src/lib/notifications/comment-email-pref.ts — keep in sync. */
export const COMMENT_EMAIL_PREFERENCE_KEY = 'commentEmails'

/**
 * Read the preference out of a `users.preferences` JSON blob.
 *
 * Total and never throws: the column is free-form JSON written by
 * `PATCH /api/v2/auth/me`, so malformed JSON, a non-object, a missing key and
 * an unrecognised value all resolve to the default. Silently defaulting is the
 * safe direction — the failure mode is "got the standard amount of email",
 * not "stopped emailing someone who expected it".
 */
export function parseCommentEmailPreference(
  preferencesJson: string | null | undefined,
): CommentEmailPreference {
  if (!preferencesJson) return DEFAULT_COMMENT_EMAIL_PREFERENCE
  let parsed: unknown
  try {
    parsed = JSON.parse(preferencesJson)
  } catch {
    return DEFAULT_COMMENT_EMAIL_PREFERENCE
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_COMMENT_EMAIL_PREFERENCE
  const value = (parsed as Record<string, unknown>)[COMMENT_EMAIL_PREFERENCE_KEY]
  return value === 'all' || value === 'mentions' || value === 'off'
    ? value
    : DEFAULT_COMMENT_EMAIL_PREFERENCE
}

/**
 * Does this recipient get an email for this notification?
 *
 * A mention always wins over "reply" noise — short of `off`, being named is the
 * one thing we never suppress.
 */
export function shouldEmailRecipient(
  kind: 'mention' | 'reply',
  preference: CommentEmailPreference,
): boolean {
  if (preference === 'off') return false
  if (kind === 'mention') return true
  return preference === 'all'
}

/** One resolved recipient: who they are, where to mail them, and how much
 *  they want. `userId` is `users.id` stringified — it is the recipient half of
 *  the side-effect queue's `(commentId, recipientUserId)` idempotency key
 *  (AQU-1824), so it has to survive resolution, not just the email address. */
export interface RecipientProfile {
  userId: string
  email: string
  preference: CommentEmailPreference
}

/**
 * Look up email + comment-email preference for a list of usernames.
 * Returns a map of username → profile (only entries that exist in the DB).
 */
export async function resolveRecipientProfiles(
  db: AquillaDb,
  usernames: string[],
): Promise<Map<string, RecipientProfile>> {
  if (usernames.length === 0) return new Map()

  // Parameterised IN clause — one placeholder per username.
  const placeholders = usernames.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT id, username, email, preferences FROM users WHERE username IN (${placeholders})`,
    )
    .bind(...usernames)
    .all<{ id: string | number; username: string; email: string; preferences: string | null }>()

  const result = new Map<string, RecipientProfile>()
  for (const row of rows.results) {
    result.set(row.username, {
      // `users.id` is BIGINT; the driver may hand it back as a number or a
      // string depending on width. Normalise so an idempotency key built from
      // it is byte-identical across retries.
      userId: String(row.id),
      email: row.email,
      preference: parseCommentEmailPreference(row.preferences),
    })
  }
  return result
}

/**
 * Filter a list of @mentioned usernames down to those with a live grant on
 * `projectId`.
 *
 * [Pen test 2026-09-24] API security & data exposure: `extractMentions` pulls
 * any `@username`-shaped token out of a comment body with no validation, and
 * `resolveUserEmails` looks usernames up globally with no project scope —
 * unlike `getThreadParticipants`, which is already scoped to actual
 * commenters on the thread. Without this filter, any project contributor
 * (including an agent posting via the external Agent API's comment.create)
 * could @mention an arbitrary registered username and cause a real email
 * (comment excerpt, project name, deep link) to be sent to an account with
 * no role on the project — a cross-tenant content leak plus a
 * username-enumeration/spam primitive. Mirrors the grant-path union in
 * events/membership.ts checkProjectMembershipDetailed, keyed by username
 * instead of user id.
 */
export async function filterUsernamesWithProjectAccess(
  db: AquillaDb,
  projectId: string,
  usernames: string[],
): Promise<string[]> {
  if (usernames.length === 0) return []

  const placeholders = usernames.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT u.username FROM users u
       WHERE u.username IN (${placeholders})
         AND (
           EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ? AND pm.user_id = u.id)
           OR EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND p.created_by = u.id)
           OR EXISTS (
             SELECT 1 FROM org_members om
               JOIN projects p ON p.org_id = om.org_id
              WHERE p.id = ? AND om.user_id = u.id AND om.role_level >= ${ROLE.MAINTAINER}
           )
           OR EXISTS (
             SELECT 1 FROM group_members gm
               JOIN group_project_grants gpg ON gpg.group_id = gm.group_id
              WHERE gpg.project_id = ? AND gm.user_id = u.id
           )
         )`,
    )
    .bind(...usernames, projectId, projectId, projectId, projectId)
    .all<{ username: string }>()

  return rows.results.map((r) => r.username)
}

/**
 * Look up thread-participant usernames for a comment thread.
 *
 * For a reply (parentCommentId !== null): returns all distinct author_ids of
 * comments in the thread (root + other replies with the same parent).
 * For a new top-level comment: no prior thread participants — returns [].
 */
export async function getThreadParticipants(
  db: AquillaDb,
  projectId: string,
  parentCommentId: string | null,
): Promise<string[]> {
  if (!parentCommentId) return []

  // The root and all its replies share the same thread root id.
  // We want authors of the root comment and any existing replies.
  const rows = await db
    .prepare(
      `SELECT DISTINCT author_id FROM comments
       WHERE project_id = ?
         AND (comment_id = ? OR parent_comment_id = ?)
         AND deleted_at IS NULL`,
    )
    .bind(projectId, parentCommentId, parentCommentId)
    .all<{ author_id: string }>()

  return rows.results.map((r) => r.author_id)
}

/**
 * Body of one live comment, or null when it is missing or soft-deleted.
 *
 * Used for two things: the thread subject (below) and, since AQU-1824, loading
 * a comment's own body in the queue consumer instead of carrying it through the
 * queue — a body may be up to 50,000 characters, which does not reliably fit a
 * queue message.
 */
export async function getCommentBody(
  db: AquillaDb,
  projectId: string,
  commentId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT body FROM comments
       WHERE project_id = ? AND comment_id = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(projectId, commentId)
    .first<{ body: string }>()
  return row?.body ?? null
}

/**
 * Body of a thread's ROOT comment, used to build the stable thread subject
 * (AQU-1193). Returns null when the root is missing or deleted — the caller
 * then falls back to the new comment's own body, so a deleted root never costs
 * the thread its subject (and therefore its grouping) mid-conversation.
 */
export async function getThreadRootBody(
  db: AquillaDb,
  projectId: string,
  rootCommentId: string,
): Promise<string | null> {
  return getCommentBody(db, projectId, rootCommentId)
}

/**
 * Look up the project display name. Returns null if not found.
 */
export async function getProjectName(
  db: AquillaDb,
  projectId: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT name FROM projects WHERE id = ? LIMIT 1`)
    .bind(projectId)
    .first<{ name: string }>()
  return row?.name ?? null
}

// ── Orchestrator ──────────────────────────────────────────────────────────

export interface CommentNotificationOpts {
  env: NotificationEnv
  db: AquillaDb
  baseUrl: string
  projectId: string
  author: string
  body: string
  parentCommentId: string | null
  /** Id of the comment that was just created. With `parentCommentId` this
   *  identifies the thread: root id = parentCommentId ?? commentId (AQU-1193).
   *  Optional so an older caller still compiles; the thread topic then falls
   *  back to this comment's own body. */
  commentId?: string
}

/**
 * Fire all mention/reply notifications for a comment.create event.
 * Best-effort — individual send failures are logged but never re-thrown
 * so a broken email provider cannot block the comment write path.
 *
 * Called via ctx.waitUntil() from the events route after DB commit.
 *
 * AQU-1193 changed two things about what actually goes out:
 *  - Recipients are filtered by each user's `commentEmails` preference, which
 *    defaults to mentions-only. Thread participants who were not named get
 *    nothing unless they opted into `all`.
 *  - Every message on one thread carries the same subject, so mail clients
 *    collapse the thread into a single conversation instead of N messages.
 */
export async function sendCommentNotifications(
  opts: CommentNotificationOpts,
): Promise<void> {
  try {
    const plan = await resolveCommentNotificationPlan(opts)
    if (!plan) return

    const sends = plan.recipients.map((recipient) =>
      sendNotificationEmail(opts.env, recipient.email, {
        authorDisplayName: plan.authorDisplayName,
        kind: recipient.kind,
        projectName: plan.projectName,
        excerpt: plan.excerpt,
        commentsUrl: plan.commentsUrl,
        threadTopic: plan.threadTopic,
        isReply: plan.isReply,
      }).catch((err) => {
        console.warn(
          `[comment-notifications] failed to send to ${recipient.username}:`,
          err,
        )
      }),
    )
    await Promise.all(sends)
  } catch (err) {
    // Top-level catch: notification failure must never propagate.
    console.warn('[comment-notifications] orchestration error:', err)
  }
}

// ── Resolution (shared with the side-effect queue) ────────────────────────

/** One recipient of a comment notification, fully resolved. */
export interface ResolvedRecipient {
  username: string
  /** `users.id` stringified — see RecipientProfile.userId. */
  userId: string
  email: string
  kind: 'mention' | 'reply'
}

/**
 * Everything needed to render and address a comment's notifications, with no
 * further database access.
 *
 * Split out of `sendCommentNotifications` for AQU-1824: the side-effect queue's
 * fan-out consumer resolves this once and then enqueues one leaf message per
 * recipient, while the inline path (no queue binding — local dev and e2e) keeps
 * sending straight from it. One resolver, so the two paths cannot drift on who
 * gets mail.
 */
export interface CommentNotificationPlan {
  /**
   * Recipients in a DETERMINISTIC order: mentions first (alphabetical by
   * username), then thread-reply recipients (alphabetical).
   *
   * The order is part of the contract, not a tidiness nicety. The recipient cap
   * is applied by slicing this list, so a stable order means a retry of the
   * same comment caps the same people — and putting mentions first means the
   * cap can only ever drop "someone replied on a thread you are in" mail, never
   * "you were named".
   */
  recipients: ResolvedRecipient[]
  authorDisplayName: string
  projectName: string
  commentsUrl: string
  excerpt: string
  threadTopic: string
  isReply: boolean
  /** Root comment id of the thread, when the caller supplied enough to know it. */
  threadRootId: string | null
}

/**
 * Resolve who gets mail for one `comment.create`, and with what copy.
 *
 * Returns null when nobody is eligible — no mentions with project access, no
 * thread participants, or everyone opted out (AQU-1193 makes mention-only the
 * default, so a thread participant who was not named gets nothing unless they
 * chose `all`).
 */
export async function resolveCommentNotificationPlan(opts: {
  db: AquillaDb
  baseUrl: string
  projectId: string
  author: string
  body: string
  parentCommentId: string | null
  commentId?: string
}): Promise<CommentNotificationPlan | null> {
  const { db, baseUrl, projectId, author, body, parentCommentId } = opts

  const rawMentionedUsernames = extractMentions(body)
  const [mentionedUsernames, threadParticipants] = await Promise.all([
    filterUsernamesWithProjectAccess(db, projectId, rawMentionedUsernames),
    getThreadParticipants(db, projectId, parentCommentId),
  ])
  const recipientUsernames = deriveRecipientUsernames({
    author,
    mentionedUsernames,
    threadParticipantUsernames: threadParticipants,
  })

  if (recipientUsernames.length === 0) return null

  // The thread's identity. A reply's root is its parent; a new top-level
  // comment IS its own root, so it seeds the subject its replies will reuse.
  const isReply = parentCommentId !== null
  const rootCommentId = parentCommentId ?? opts.commentId ?? null

  const [profiles, projectName, rootBody] = await Promise.all([
    resolveRecipientProfiles(db, recipientUsernames),
    getProjectName(db, projectId),
    isReply && rootCommentId
      ? getThreadRootBody(db, projectId, rootCommentId)
      : Promise.resolve(null),
  ])

  const mentionedSet = new Set(mentionedUsernames)
  const mentions: ResolvedRecipient[] = []
  const replies: ResolvedRecipient[] = []
  for (const username of recipientUsernames) {
    const profile = profiles.get(username)
    if (!profile) continue
    const kind: 'mention' | 'reply' = mentionedSet.has(username) ? 'mention' : 'reply'
    // Mention-only by default — a thread participant who was not named gets
    // nothing unless they opted into `all` (AQU-1193).
    if (!shouldEmailRecipient(kind, profile.preference)) continue
    const resolved: ResolvedRecipient = {
      username,
      userId: profile.userId,
      email: profile.email,
      kind,
    }
    ;(kind === 'mention' ? mentions : replies).push(resolved)
  }

  const byUsername = (a: ResolvedRecipient, b: ResolvedRecipient) =>
    a.username < b.username ? -1 : a.username > b.username ? 1 : 0
  const recipients = [...mentions.sort(byUsername), ...replies.sort(byUsername)]
  if (recipients.length === 0) return null

  return {
    recipients,
    authorDisplayName: author,
    projectName: projectName ?? projectId,
    commentsUrl: `${baseUrl}/project/${projectId}/comments`,
    excerpt: mentionDisplayText(body).slice(0, 200),
    threadTopic: threadTopicFromBody(rootBody ?? body),
    isReply,
    threadRootId: rootCommentId,
  }
}

// ── Thread digest (AQU-1824 recipient cap) ───────────────────────────────

/**
 * Mail for a recipient past the per-comment recipient cap.
 *
 * It names no single comment on purpose: the digest exists precisely because
 * this thread is generating more notifications than one message each, and it is
 * coalesced per (thread, recipient, UTC day) by the delivery ledger. So it says
 * "this thread is active, here it is" and lets the app show the detail.
 */
export interface ThreadDigestPayload {
  projectName: string
  commentsUrl: string
  threadTopic: string
}

function buildDigestHtml(p: ThreadDigestPayload): string {
  const projectName = escapeHtml(p.projectName)
  const threadTopic = escapeHtml(p.threadTopic)
  return `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <p>There is new comment activity on a thread you are part of in <strong>${projectName}</strong>:</p>
          <blockquote style="border-left: 3px solid #e5e7eb; padding-left: 12px; color: #374151; margin: 12px 0;">
            ${threadTopic}
          </blockquote>
          <p style="margin: 20px 0; text-align: center;">
            <a href="${p.commentsUrl}"
               style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">
              View thread
            </a>
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #6b7280; font-size: 0.875rem;">
            This thread has more participants than we send individual notifications for,
            so you are getting one summary instead of a message per comment.
            Change or turn off comment email under Preferences &rarr; Notifications.
          </p>
        </div>
      </body>
    </html>
  `.trim()
}

/** Subject for a digest. Shares the thread's subject shape so mail clients
 *  still collapse it into the same conversation as the per-comment mail. */
export function digestSubject(payload: ThreadDigestPayload): string {
  return threadSubject({
    authorDisplayName: '',
    kind: 'reply',
    projectName: payload.projectName,
    excerpt: '',
    commentsUrl: payload.commentsUrl,
    threadTopic: payload.threadTopic,
    isReply: true,
  })
}

/** Send one thread digest. No-ops without the EMAIL binding, and throws on a
 *  provider error so the queue consumer can retry — same contract as
 *  `sendNotificationEmail`. */
export async function sendThreadDigestEmail(
  env: NotificationEnv,
  toEmail: string,
  payload: ThreadDigestPayload,
): Promise<void> {
  if (!env.EMAIL) return
  const from = env.EMAIL_FROM ?? 'noreply@support.aquilla.app'
  const text =
    `There is new comment activity on a thread you are part of in ${payload.projectName}.\n\n` +
    `${payload.threadTopic}\n\nView: ${payload.commentsUrl}`
  try {
    await env.EMAIL.send({
      from,
      to: [toEmail],
      subject: digestSubject(payload),
      html: buildDigestHtml(payload),
      text,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to send digest email: ${message}`, { cause: err })
  }
}
