/**
 * @mention token rules shared by the comment composer and `extractMentions`.
 *
 * The notification path (email and the in-app inbox) only reads a mention that
 * `extractMentions` can parse: an `@` at the start of the text or after
 * whitespace, then a username that starts with a letter. Opening the picker on
 * any `@` — including the one inside `me@example.com` — used to insert a token
 * that path can never see.
 */

export interface MentionCandidate {
  username: string
}

export interface MentionToken {
  /** Index of the `@` that opens the token. */
  start: number
  /** Characters typed after that `@`, up to the caret. Empty when the user just typed `@`. */
  query: string
}

const QUERY = /^[a-zA-Z][a-zA-Z0-9_]*$/

/**
 * The mention token the caret is inside, or null when the `@` before the caret
 * is not a mention boundary `extractMentions` would accept.
 */
export function mentionTokenAt(text: string, cursor: number): MentionToken | null {
  const upTo = text.slice(0, Math.max(0, cursor))
  const at = upTo.lastIndexOf("@")
  if (at < 0) return null
  if (at > 0 && !/\s/.test(upTo[at - 1] ?? "")) return null
  const query = upTo.slice(at + 1)
  if (/\s/.test(query)) return null
  if (query.length > 0 && !QUERY.test(query)) return null
  return { start: at, query }
}

function byUsername(a: MentionCandidate, b: MentionCandidate): number {
  return a.username.localeCompare(b.username, undefined, { sensitivity: "base" })
}

/**
 * Roster matches for a mention query. Prefix matches come first, then
 * substring matches; each group is alphabetical. The signed-in user is
 * omitted — mentioning yourself does not notify anyone.
 */
export function rankMentionSuggestions(
  roster: readonly MentionCandidate[],
  query: string,
  excludeUsername?: string | null,
): MentionCandidate[] {
  const q = query.toLowerCase()
  const exclude = excludeUsername?.trim().toLowerCase() || null
  const seen = new Set<string>()
  const prefix: MentionCandidate[] = []
  const substring: MentionCandidate[] = []
  for (const member of roster) {
    const name = member.username.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (exclude && key === exclude) continue
    const candidate = { username: name }
    if (q.length === 0 || key.startsWith(q)) prefix.push(candidate)
    else if (key.includes(q)) substring.push(candidate)
  }
  prefix.sort(byUsername)
  substring.sort(byUsername)
  return [...prefix, ...substring]
}

/**
 * Replace the active token with a confirmed mention and report the caret.
 * The stored form `@[username]` is a different value from typed `@username`:
 * only the bracket form notifies, and only Enter or a click writes it.
 */
export function applyMention(
  value: string,
  token: MentionToken,
  username: string,
): { value: string; caret: number } {
  const before = value.slice(0, token.start)
  const after = value.slice(token.start + 1 + token.query.length).replace(/^\s+/, "")
  const inserted = `@[${username}] `
  return {
    value: after.length > 0 ? `${before}${inserted}${after}` : `${before}${inserted}`,
    caret: before.length + inserted.length,
  }
}
