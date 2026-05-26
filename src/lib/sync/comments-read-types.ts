// Types for the sync-worker comments read API.
// Mirror of sync-worker/src/events/comments-read-route.ts CommentRowOut.

export interface CommentRecord {
  commentId: string
  projectId: string
  scopeKind: 'cell' | 'file' | 'project'
  fileId: string | null
  cellId: string | null
  parentCommentId: string | null
  body: string
  resolved: boolean
  authorId: string
  authorLabel: string | null
  createdAt: number
  updatedAt: number
  /** Non-null means soft-deleted. UI renders "[deleted]" placeholder. */
  deletedAt: number | null
}

export interface CommentsResponse {
  comments: CommentRecord[]
}

export interface FetchCommentsOptions {
  fileId?: string
  cellId?: string
}
