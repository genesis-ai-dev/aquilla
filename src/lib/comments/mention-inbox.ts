import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { extractMentions, mentionDisplayText } from "./comment-helpers"

/**
 * One row in the in-app notifications inbox.
 *
 * Derived from the comments the reader can already see. There is no
 * notification table: a deleted comment cannot leave a row pointing at
 * nothing, and a mention removed by an edit disappears with it.
 */
export interface MentionNotice {
  commentId: string
  authorId: string
  authorLabel: string
  excerpt: string
  createdAt: number
  scopeKind: CommentRecord["scopeKind"]
  fileId: string | null
  cellId: string | null
  /** Canonical verse or chapter address, when the cell has one. */
  cellRef: string | null
  /**
   * Plain cell text saved on the thread when it was opened. Used when the
   * cell has no verse or chapter address. A reply borrows its root's text.
   */
  cellText: string | null
}

/** Enough of a busy project to scan; older mentions fall off the window. */
const MAX_NOTICES = 200
const EXCERPT_LENGTH = 140

const CELL_TEXT_LENGTH = 80

/** One line of cell text, with tags and extra space removed. */
export function cellTextSnippet(value: string | null | undefined): string | null {
  if (!value) return null
  const flat = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  if (!flat) return null
  if (flat.length <= CELL_TEXT_LENGTH) return flat
  return `${flat.slice(0, CELL_TEXT_LENGTH - 1)}…`
}

function cellTextOf(comment: CommentRecord, byId: ReadonlyMap<string, CommentRecord>): string | null {
  let current: CommentRecord | undefined = comment
  const seen = new Set<string>()
  while (current && !seen.has(current.commentId)) {
    seen.add(current.commentId)
    const text = cellTextSnippet(current.createdForTranslated)
    if (text) return text
    current = current.parentCommentId ? byId.get(current.parentCommentId) : undefined
  }
  return null
}

function excerptOf(body: string): string {
  const flat = mentionDisplayText(body).replace(/\s+/g, " ").trim()
  if (flat.length <= EXCERPT_LENGTH) return flat
  return `${flat.slice(0, EXCERPT_LENGTH - 1)}…`
}

/**
 * Comments that @mention `readerUsername`, newest first.
 *
 * The reader is never notified about their own comment, including one that
 * names them. Matching is case-insensitive so `@Alice` and `alice` are the
 * same person; the composer still inserts the roster's exact username, which
 * is what the email loop looks up.
 */
export function mentionNoticesFor(
  comments: readonly CommentRecord[],
  readerUsername: string,
): MentionNotice[] {
  const reader = readerUsername.trim().toLowerCase()
  if (!reader) return []

  const byId = new Map(comments.map((comment) => [comment.commentId, comment]))
  const notices: MentionNotice[] = []
  for (const comment of comments) {
    if (comment.deletedAt != null) continue
    if (comment.authorId.trim().toLowerCase() === reader) continue
    const mentioned = extractMentions(comment.body).some(
      (name) => name.toLowerCase() === reader,
    )
    if (!mentioned) continue
    notices.push({
      commentId: comment.commentId,
      authorId: comment.authorId,
      authorLabel: comment.authorLabel?.trim() || comment.authorId,
      excerpt: excerptOf(comment.body),
      createdAt: comment.createdAt,
      scopeKind: comment.scopeKind,
      fileId: comment.fileId,
      cellId: comment.cellId,
      cellRef: comment.cellRef?.trim() || null,
      cellText: cellTextOf(comment, byId),
    })
  }

  notices.sort(
    (a, b) => b.createdAt - a.createdAt || a.commentId.localeCompare(b.commentId),
  )
  return notices.slice(0, MAX_NOTICES)
}
