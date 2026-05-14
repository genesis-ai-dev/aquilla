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
