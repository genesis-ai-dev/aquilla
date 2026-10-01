/**
 * comment-email-pref.ts — the user's comment-email dial (AQU-1193).
 *
 * Account-scoped, not device-scoped: it decides what a Worker sends to an
 * inbox, so it has to live on the server. It rides in the existing
 * `users.preferences` JSON blob (`PATCH /api/v2/auth/me`) rather than a new
 * column — the blob already exists, the endpoint already accepts it, and the
 * sync-worker already reads that row when it resolves recipients.
 *
 * MIRROR: sync-worker/src/notification-email.ts holds the authoritative copy of
 * the value union, the default, and the blob key (the Worker is the one that
 * decides whether mail goes out). Keep the three in sync — same reason
 * `extractMentions` is duplicated there.
 */

import { AUTH_BASE } from "../frontier/auth"
import { fetchWithTimeout } from "../frontier/orgs"

/**
 * - `all`      — every mention and every reply on a thread you are in.
 * - `mentions` — only comments that @-mention you. The default.
 * - `off`      — no comment email at all.
 */
export type CommentEmailPreference = "all" | "mentions" | "off"

export const COMMENT_EMAIL_PREFERENCES: readonly CommentEmailPreference[] = [
  "all",
  "mentions",
  "off",
] as const

/** Mention-only. Matches DEFAULT_COMMENT_EMAIL_PREFERENCE in the worker. */
export const DEFAULT_COMMENT_EMAIL_PREFERENCE: CommentEmailPreference = "mentions"

/** Key inside the `users.preferences` blob. Matches the worker's constant. */
export const COMMENT_EMAIL_PREFERENCE_KEY = "commentEmails"

/** Narrow an arbitrary blob value to a preference, defaulting on anything else. */
export function parseCommentEmailPreference(value: unknown): CommentEmailPreference {
  return value === "all" || value === "mentions" || value === "off"
    ? value
    : DEFAULT_COMMENT_EMAIL_PREFERENCE
}

/** GET /api/v2/auth/me → the whole preferences blob (`{}` when absent). */
export async function fetchUserPreferences(jwt: string): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(`${AUTH_BASE}/api/v2/auth/me`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`preferences fetch failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  const parsed = (await res.json()) as { preferences?: unknown }
  return parsed.preferences && typeof parsed.preferences === "object"
    ? (parsed.preferences as Record<string, unknown>)
    : {}
}

/** The caller's current setting, or the default when they've never set one. */
export async function fetchCommentEmailPreference(
  jwt: string,
): Promise<CommentEmailPreference> {
  const preferences = await fetchUserPreferences(jwt)
  return parseCommentEmailPreference(preferences[COMMENT_EMAIL_PREFERENCE_KEY])
}

/**
 * Persist the setting.
 *
 * Read-modify-write on purpose: `PATCH /api/v2/auth/me` REPLACES the whole
 * preferences object (`UPDATE users SET preferences = ?`), so sending only this
 * key would silently delete every other preference the account holds. The read
 * is a fresh GET rather than cached state so a value written from another tab
 * or device isn't clobbered either.
 */
export async function saveCommentEmailPreference(
  jwt: string,
  preference: CommentEmailPreference,
): Promise<CommentEmailPreference> {
  const current = await fetchUserPreferences(jwt)
  const next = { ...current, [COMMENT_EMAIL_PREFERENCE_KEY]: preference }
  const res = await fetchWithTimeout(`${AUTH_BASE}/api/v2/auth/me`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ preferences: next }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`preferences save failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  const parsed = (await res.json()) as { preferences?: Record<string, unknown> }
  return parseCommentEmailPreference(parsed.preferences?.[COMMENT_EMAIL_PREFERENCE_KEY])
}
