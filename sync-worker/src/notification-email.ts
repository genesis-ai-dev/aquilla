// Best-effort comment notification emails for sync-worker.
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

/**
 * Extract @username mentions from a comment body.
 * Mirrors src/lib/comments/comment-helpers.ts extractMentions — keep in sync.
 */
export function extractMentions(text: string): string[] {
  const mentions = new Set<string>()
  const re = /(?:^|\s)@([a-zA-Z][a-zA-Z0-9_]*)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    mentions.add(match[1])
  }
  return Array.from(mentions)
}

export interface NotificationEmailPayload {
  /** Display name of the person who posted the comment. */
  authorDisplayName: string
  /** Notification kind — controls subject + headline copy. */
  kind: 'mention' | 'reply'
  /** Project display name. */
  projectName: string
  /** Plain-text excerpt of the comment body (≤200 chars). */
  excerpt: string
  /** Deep link to the project's comments page. */
  commentsUrl: string
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
            You are receiving this because you were mentioned or participated in this thread.
          </p>
        </div>
      </body>
    </html>
  `.trim()
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
  // Strip CR/LF so an attacker-controlled display name/project name can't
  // inject extra headers into the outbound message via the subject line.
  const authorForSubject = payload.authorDisplayName.replace(/[\r\n]+/g, ' ')
  const projectForSubject = payload.projectName.replace(/[\r\n]+/g, ' ')
  const subject =
    payload.kind === 'mention'
      ? `${authorForSubject} mentioned you in ${projectForSubject}`
      : `New reply in ${projectForSubject}`
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

/**
 * Look up emails for a list of usernames from the `users` table.
 * Returns a map of username → email (only entries that exist in the DB).
 */
export async function resolveUserEmails(
  db: AquillaDb,
  usernames: string[],
): Promise<Map<string, string>> {
  if (usernames.length === 0) return new Map()

  // Parameterised IN clause — one placeholder per username.
  const placeholders = usernames.map(() => '?').join(', ')
  const rows = await db
    .prepare(`SELECT username, email FROM users WHERE username IN (${placeholders})`)
    .bind(...usernames)
    .all<{ username: string; email: string }>()

  const result = new Map<string, string>()
  for (const row of rows.results) {
    result.set(row.username, row.email)
  }
  return result
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
}

/**
 * Fire all mention/reply notifications for a comment.create event.
 * Best-effort — individual send failures are logged but never re-thrown
 * so a broken email provider cannot block the comment write path.
 *
 * Called via ctx.waitUntil() from the events route after DB commit.
 */
export async function sendCommentNotifications(
  opts: CommentNotificationOpts,
): Promise<void> {
  try {
    const {
      env, db, baseUrl, projectId, author, body, parentCommentId,
    } = opts

    const mentionedUsernames = extractMentions(body)
    const threadParticipants = await getThreadParticipants(db, projectId, parentCommentId)
    const recipientUsernames = deriveRecipientUsernames({
      author,
      mentionedUsernames,
      threadParticipantUsernames: threadParticipants,
    })

    if (recipientUsernames.length === 0) return

    const [emailMap, projectName] = await Promise.all([
      resolveUserEmails(db, recipientUsernames),
      getProjectName(db, projectId),
    ])

    const commentsUrl = `${baseUrl}/project/${projectId}/comments`
    const excerpt = body.slice(0, 200)
    const authorDisplay = author

    const sends: Promise<void>[] = []
    for (const username of recipientUsernames) {
      const email = emailMap.get(username)
      if (!email) continue
      const isMentioned = mentionedUsernames.includes(username)
      const kind: 'mention' | 'reply' = isMentioned ? 'mention' : 'reply'
      sends.push(
        sendNotificationEmail(env, email, {
          authorDisplayName: authorDisplay,
          kind,
          projectName: projectName ?? projectId,
          excerpt,
          commentsUrl,
        }).catch((err) => {
          console.warn(`[comment-notifications] failed to send to ${username}:`, err)
        }),
      )
    }
    await Promise.all(sends)
  } catch (err) {
    // Top-level catch: notification failure must never propagate.
    console.warn('[comment-notifications] orchestration error:', err)
  }
}
