/**
 * comment-email-pref.ts — the user's comment-email dial (AQU-1193).
 *
 * Account-scoped, not device-scoped: it decides what a Worker sends to an
 * inbox, so it has to live on the server. It rides in the existing
 * `users.preferences` JSON blob rather than a new column — the blob already
 * exists, and the sync-worker already reads that row when it resolves
 * recipients. Reads and writes go through `person-prefs-api` (AQU-2264), which
 * merges only this key, so it can never undo another preference.
 *
 * MIRROR: sync-worker/src/notification-email.ts holds the authoritative copy of
 * the value union, the default, and the blob key (the Worker is the one that
 * decides whether mail goes out). Keep the three in sync — same reason
 * `extractMentions` is duplicated there.
 */

import { fetchPersonPreferences, patchPersonPreferences } from "@/lib/prefs/person-prefs-api"

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

/** The caller's current setting, or the default when they've never set one. */
export async function fetchCommentEmailPreference(
  jwt: string,
): Promise<CommentEmailPreference> {
  const preferences = await fetchPersonPreferences(jwt)
  return parseCommentEmailPreference(preferences[COMMENT_EMAIL_PREFERENCE_KEY])
}

/**
 * Persist the setting. Sends only this key: the server merges it, so every
 * other preference on the account — including one another device writes at
 * the same moment — stays as it is.
 */
export async function saveCommentEmailPreference(
  jwt: string,
  preference: CommentEmailPreference,
): Promise<CommentEmailPreference> {
  const stored = await patchPersonPreferences(jwt, { set: { [COMMENT_EMAIL_PREFERENCE_KEY]: preference } })
  return parseCommentEmailPreference(stored[COMMENT_EMAIL_PREFERENCE_KEY])
}
