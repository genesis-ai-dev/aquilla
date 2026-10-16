// AQU-1958: CSV serializer for a comment thread list — the Comments page's
// Export, and the org-wide view's.
//
// One row per message, not per thread: a thread's shape survives the export
// through `Thread` (the root's id, shared by every message in it) and
// `Reply to` (the message's parent), so a reader can sort by Thread and still
// read a conversation in order, and a pivot table can count threads.
//
// Column text is deliberately plain English literals rather than i18n keys,
// following the AQU-1093 plan export: the file gets mailed on and opened by
// someone who never saw the app, and a spreadsheet column is filtered on its
// text. Comment bodies and author names are user content and are never
// translated.

import { mentionDisplayText } from "./comment-helpers"
import { CSV_EOL, toSafeCsvLine } from "@/lib/progress/progress-csv"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

/** One thread as the page has it on screen, with its labels already resolved. */
export interface CommentCsvThread {
  root: CommentRecord
  replies: readonly CommentRecord[]
  /** Project display name — never the raw id (AQU-295). */
  projectName: string
  /**
   * File display name, or the caller's tombstone for a deleted file. Empty for
   * a project-scoped thread, which belongs to no file.
   */
  fileName: string
  /**
   * Human-readable cell address (e.g. "GEN 1:1"), when the page resolved one.
   * Empty for file- and project-scoped threads, and for cells with no
   * canonical reference.
   */
  reference: string
}

export const COMMENTS_CSV_HEADER = [
  "Project",
  "File",
  "Reference",
  "Scope",
  "Thread",
  "Message",
  "Reply to",
  "Author",
  "Created",
  "Updated",
  "Resolved",
  "Deleted",
  "Comment",
] as const

/** What the deleted-body placeholder reads as in the export. */
const DELETED_BODY = "[deleted]"

function scopeText(scopeKind: CommentRecord["scopeKind"]): string {
  if (scopeKind === "cell") return "Cell"
  if (scopeKind === "file") return "File"
  return "Project"
}

/**
 * Epoch milliseconds as an ISO-8601 UTC timestamp. UTC on purpose: an export
 * compared across BGP's editorial leads in different timezones has to mean the
 * same instant in every copy, and a spreadsheet parses this form.
 */
function isoTime(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * Rows for one thread: the root first, then its replies in creation order —
 * the reading order of the thread on screen.
 */
export function commentThreadCsvRows(thread: CommentCsvThread): string[][] {
  const resolved = thread.root.resolved ? "Yes" : "No"
  const messages = [
    thread.root,
    ...[...thread.replies].sort((a, b) => a.createdAt - b.createdAt),
  ]
  return messages.map((message) => [
    thread.projectName,
    thread.fileName,
    thread.reference,
    scopeText(thread.root.scopeKind),
    thread.root.commentId,
    message.commentId,
    message.parentCommentId ?? "",
    message.authorLabel ?? message.authorId,
    isoTime(message.createdAt),
    isoTime(message.updatedAt),
    resolved,
    message.deletedAt != null ? "Yes" : "No",
    // A soft-deleted comment's body is not shown in the app and must not leak
    // through the export either — the row stays so the thread's shape and the
    // reply chain still read correctly.
    message.deletedAt != null ? DELETED_BODY : mentionDisplayText(message.body),
  ])
}

/**
 * The whole visible list as a CSV string, header included, CRLF per RFC 4180.
 *
 * Order and membership are the caller's: pass exactly the threads on screen,
 * already filtered and sorted, so the file matches what the person exporting it
 * is looking at.
 */
export function commentThreadsToCsv(threads: readonly CommentCsvThread[]): string {
  const lines = [
    toSafeCsvLine(COMMENTS_CSV_HEADER),
    ...threads.flatMap((thread) => commentThreadCsvRows(thread).map(toSafeCsvLine)),
  ]
  return lines.join(CSV_EOL)
}

/**
 * Filesystem-safe download name, e.g. "Oromo NT-comments.csv". Mirrors
 * `progressCsvFilename` so downloads from every export surface look alike.
 */
export function commentsCsvFilename(label: string): string {
  const safe = label.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  return `${safe || "comments"}-comments.csv`
}

/** The export blob, ready for `downloadBlob`. */
export function commentsCsvBlob(threads: readonly CommentCsvThread[]): Blob {
  return new Blob([commentThreadsToCsv(threads)], { type: "text/csv;charset=utf-8" })
}
