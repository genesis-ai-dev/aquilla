/**
 * useComments — live threaded comments on the v3 event log.
 *
 * Replaces the old stub that referenced Y.Doc maps. Comments are now
 * persisted as comment.* events through the outbox → sync-worker →
 * comments projection table pipeline.
 *
 * Usage:
 *   const { comments, isLoading, addComment, editComment, deleteComment,
 *           resolveThread, refresh } = useComments({ projectId, getToken, author })
 *
 * The `scope` accepted by `addComment` is a CommentScope discriminated union
 * so the same hook handles cell comments, file comments, and project comments.
 *
 * Comments are non-chain-mutating: no focus lock needed and no parentId
 * tracking. The outbox enqueues them as standalone events.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { v7 as uuidv7 } from "uuid"
import { enqueueEvent } from "@/lib/sync/events-emit"
import { fetchCommentsForProject } from "@/lib/sync/comments-read"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import type { CommentScope } from "@/lib/sync/outbox-types"

export type { CommentRecord, CommentScope }

export interface UseCommentsOptions {
  projectId: string | null
  /**
   * Token fetcher — same signature as `getToken` in useWorkspaceSearch.
   * Any file-scoped sync-token for the project works (project reads only
   * check the projectId from the JWT, not the fileId).
   */
  getToken?: (fileId: string) => Promise<string | null>
  /** Current username — stamped as `author` on emitted events. */
  author: string
  /** Optional narrow scope — when set, only loads comments for this scope. */
  scope?: { fileId?: string; cellId?: string }
}

export interface UseCommentsApi {
  comments: CommentRecord[]
  isLoading: boolean
  isError: boolean
  /**
   * Add a new comment. Returns the client-generated commentId so callers
   * can reference it immediately in optimistic UI.
   */
  addComment: (opts: {
    scope: CommentScope
    body: string
    parentCommentId?: string | null
  }) => Promise<string>
  editComment: (commentId: string, body: string) => Promise<void>
  deleteComment: (commentId: string) => Promise<void>
  resolveThread: (commentId: string, resolved: boolean) => Promise<void>
  refresh: () => Promise<void>
}

export function useComments(opts: UseCommentsOptions): UseCommentsApi {
  const { projectId, getToken, author, scope } = opts

  const [comments, setComments] = useState<CommentRecord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  // Keep latest props in refs so callbacks don't close over stale values.
  const projectRef = useRef(projectId)
  const tokenRef = useRef(getToken)
  const authorRef = useRef(author)
  const scopeRef = useRef(scope)
  useEffect(() => {
    projectRef.current = projectId
    tokenRef.current = getToken
    authorRef.current = author
    scopeRef.current = scope
  }, [projectId, getToken, author, scope])

  const refresh = useCallback(async () => {
    const pid = projectRef.current
    const fetchToken = tokenRef.current
    if (!pid) return

    setIsLoading(true)
    setIsError(false)
    try {
      // Use any file as the token scope — project-level reads only verify projectId.
      const token = fetchToken ? await fetchToken('any') : null
      if (!token) {
        setIsLoading(false)
        return
      }
      const sc = scopeRef.current
      const rows = await fetchCommentsForProject(pid, token, {
        fileId: sc?.fileId,
        cellId: sc?.cellId,
      })
      setComments(rows)
    } catch (err) {
      console.warn('[useComments] fetch failed:', err)
      setIsError(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Load on mount and when projectId changes.
  useEffect(() => {
    if (projectId) {
      refresh().catch(() => {/* refresh sets isError */})
    }
  }, [projectId, refresh])

  const addComment = useCallback(
    async ({
      scope: commentScope,
      body,
      parentCommentId = null,
    }: {
      scope: CommentScope
      body: string
      parentCommentId?: string | null
    }): Promise<string> => {
      const pid = projectRef.current
      if (!pid) return ''
      const commentId = uuidv7()
      // Promote fileId from scope to the event envelope so outbox-flush.ts
      // can mint a sync token (line 115 skips events with no envelope fileId).
      const envelopeFileId =
        commentScope.kind === 'cell' || commentScope.kind === 'file'
          ? commentScope.fileId
          : undefined
      await enqueueEvent({
        kind: 'comment.create',
        projectId: pid,
        fileId: envelopeFileId,
        parentId: null,
        author: authorRef.current,
        payload: {
          commentId,
          scope: commentScope,
          body,
          parentCommentId: parentCommentId ?? null,
        },
      })
      // Optimistic update: add locally before the server round-trip.
      const now = Date.now()
      const scopeKind = commentScope.kind
      const fileId = scopeKind === 'cell' ? commentScope.fileId : scopeKind === 'file' ? commentScope.fileId : null
      const cellId = scopeKind === 'cell' ? commentScope.cellId : null
      setComments((prev) => [
        ...prev,
        {
          commentId,
          projectId: pid,
          scopeKind,
          fileId,
          cellId,
          parentCommentId: parentCommentId ?? null,
          body,
          resolved: false,
          authorId: authorRef.current,
          authorLabel: authorRef.current,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      ])
      return commentId
    },
    [],
  )

  const editComment = useCallback(async (commentId: string, body: string) => {
    const pid = projectRef.current
    if (!pid) return
    await enqueueEvent({
      kind: 'comment.edit',
      projectId: pid,
      parentId: null,
      author: authorRef.current,
      payload: { commentId, body },
    })
    // Optimistic update.
    setComments((prev) =>
      prev.map((c) =>
        c.commentId === commentId ? { ...c, body, updatedAt: Date.now() } : c,
      ),
    )
  }, [])

  const deleteComment = useCallback(async (commentId: string) => {
    const pid = projectRef.current
    if (!pid) return
    await enqueueEvent({
      kind: 'comment.delete',
      projectId: pid,
      parentId: null,
      author: authorRef.current,
      payload: { commentId },
    })
    // Optimistic soft-delete: mark deleted_at locally, body → empty.
    const now = Date.now()
    setComments((prev) =>
      prev.map((c) =>
        c.commentId === commentId
          ? { ...c, body: '', deletedAt: now, updatedAt: now }
          : c,
      ),
    )
  }, [])

  const resolveThread = useCallback(async (commentId: string, resolved: boolean) => {
    const pid = projectRef.current
    if (!pid) return
    await enqueueEvent({
      kind: 'comment.resolve',
      projectId: pid,
      parentId: null,
      author: authorRef.current,
      payload: { commentId, resolved },
    })
    // Optimistic update.
    setComments((prev) =>
      prev.map((c) =>
        c.commentId === commentId ? { ...c, resolved, updatedAt: Date.now() } : c,
      ),
    )
  }, [])

  return { comments, isLoading, isError, addComment, editComment, deleteComment, resolveThread, refresh }
}
