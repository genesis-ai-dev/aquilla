/**
 * AQU-692: decide whether a comment thread's amber "stale" badge should show.
 *
 * A thread is stale only when the target text has genuinely changed since the
 * thread was created — i.e. we have a real snapshot of what the translation was
 * at creation time and it differs from the current translation.
 *
 * `createdForTranslated` is the snapshot captured on `comment.create`. It is
 * `null`/`undefined` for an *unknown baseline*: threads created before this was
 * captured, and threads imported from a git project. In that case we must show
 * NO badge rather than compare against an empty string (which would flag every
 * translated cell's threads as stale forever — the original bug).
 */
export function isThreadStale(
  createdForTranslated: string | null | undefined,
  currentTranslated: string,
): boolean {
  if (createdForTranslated == null) return false // unknown baseline → no badge
  return createdForTranslated !== currentTranslated
}

/**
 * AQU-1233: suffix the projection appends to a comment's display label when the
 * comment was posted through the Agent API rather than typed by its author.
 * KEEP IN SYNC with sync-worker/src/events/comment-authorship.ts.
 */
export const AGENT_COMMENT_LABEL_SUFFIX = " (via agent)"

/**
 * The person behind a comment label, without the agent marker.
 *
 * Comment rows are shown per-comment, where the marker is the point. The author
 * FILTER is per-person: one entry per authorId, so it must read as the person's
 * name whichever of their comments happened to be seen last.
 */
export function stripAgentCommentMarker(label: string): string {
  return label.endsWith(AGENT_COMMENT_LABEL_SUFFIX)
    ? label.slice(0, -AGENT_COMMENT_LABEL_SUFFIX.length)
    : label
}

/**
 * A confirmed mention. Typed `@name` is ordinary text and does not notify
 * anyone. Enter (or a click on the suggestion) stores this token instead.
 *
 * The brackets delimit the username, so the capture takes anything a roster
 * username can hold. Registration accepts any 3–50 characters, and live
 * usernames carry hyphens, dots and digits (`qa-bot-2`); a class limited to
 * `[a-zA-Z0-9_]` left those mentions as raw text with no chip and no notice.
 * Only brackets and line breaks are excluded, so a stray `[` cannot swallow
 * the next token.
 * KEEP IN SYNC with sync-worker/src/notification-email.ts MENTION_TOKEN_SOURCE.
 */
export const MENTION_TOKEN_SOURCE = String.raw`@\[([^\[\]\r\n]+)\]`

/** A fresh global matcher. `exec` loops need their own `lastIndex`. */
export function mentionTokenRegex(): RegExp {
  return new RegExp(MENTION_TOKEN_SOURCE, "g")
}

/**
 * A confirmed mention, matching Linear's rendered user tag: an inline
 * medium-weight `@Name` with no pill. The composer marks the same node
 * `contenteditable=false` so it deletes as one object.
 */
export const MENTION_CHIP_CLASS = "mention font-medium text-foreground"

export function extractMentions(text: string): string[] {
  const mentions = new Set<string>()
  const re = mentionTokenRegex()
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    mentions.add(match[1])
  }
  return Array.from(mentions)
}

/** Show a confirmed mention as `@name` in plain text (inbox excerpts). */
export function mentionDisplayText(text: string): string {
  return text.replace(mentionTokenRegex(), "@$1")
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

export function renderCommentHtml(text: string): string {
  let html = escapeHtml(text)
  html = html.replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>")
  html = html.replace(/\*([^*]+?)\*/g, "<i>$1</i>")
  html = html.replace(/`([^`]+?)`/g, "<code>$1</code>")
  html = html.replace(mentionTokenRegex(), `<span class="${MENTION_CHIP_CLASS}">@$1</span>`)
  html = html.replace(/\n/g, "<br>")
  return html
}
