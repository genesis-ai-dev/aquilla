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

export function extractMentions(text: string): string[] {
  const mentions = new Set<string>()
  const re = /(?:^|\s)@([a-zA-Z][a-zA-Z0-9_]*)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    mentions.add(match[1])
  }
  return Array.from(mentions)
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
  html = html.replace(/(^|\s)@([a-zA-Z][a-zA-Z0-9_]*)/g, '$1<span class="mention">@$2</span>')
  html = html.replace(/\n/g, "<br>")
  return html
}
