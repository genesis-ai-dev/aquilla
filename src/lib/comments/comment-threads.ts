// AQU-1958: split a flat comment list into threads.
//
// The read API returns every comment in creation order, roots and replies
// mixed. Both comment list surfaces (a project's page and the org-wide view)
// need the same shape — roots to render and filter, replies keyed by the root
// they hang off — so the grouping lives here rather than in either page.

import type { CommentRecord } from "@/lib/sync/comments-read-types"

export interface CommentThreads {
  /** Top-level comments, in the order they arrived. */
  roots: CommentRecord[]
  /** Replies keyed by `parentCommentId`, in the order they arrived. */
  repliesByParent: Map<string, CommentRecord[]>
}

export function splitCommentThreads(comments: readonly CommentRecord[]): CommentThreads {
  const roots: CommentRecord[] = []
  const repliesByParent = new Map<string, CommentRecord[]>()
  for (const comment of comments) {
    if (comment.parentCommentId === null) {
      roots.push(comment)
    } else {
      const siblings = repliesByParent.get(comment.parentCommentId) ?? []
      siblings.push(comment)
      repliesByParent.set(comment.parentCommentId, siblings)
    }
  }
  return { roots, repliesByParent }
}
