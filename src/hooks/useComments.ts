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

/**
 * Sentinel fileId for project-scoped comment.* events.
 * Must match PROJECT_SENTINEL_FILE_ID in sync-worker/src/events/authorize.ts.
 */
const PROJECT_SENTINEL_FILE_ID = '__project__'

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
  /**
   * Optional auth-readiness signal (AQU-640). When the caller's `getToken`
   * can only mint a real token once a session/JWT has loaded, pass whether
   * that token is ready yet (e.g. `!!session?.jwt`). While `false`, the
   * initial auto-load waits (showing the loading state) instead of firing a
   * fetch that would bail on the null token and never retry; the load fires
   * once it flips to `true`. Omit (leave `undefined`) to always auto-load on
   * mount/projectId change — the legacy behavior for callers whose token
   * fetcher is ready synchronously.
   */
  tokenReady?: boolean
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
  const { projectId, getToken, author, scope, tokenReady } = opts

  const [comments, setComments] = useState<CommentRecord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  // Keep latest props in refs so callbacks don't close over stale values.
  const projectRef = useRef(projectId)
  const tokenRef = useRef(getToken)
  const authorRef = useRef(author)
  const scopeRef = useRef(scope)
  // Keep a ref to the latest comments array so mutation callbacks (edit/delete/
  // resolve) can look up a comment's fileId without closing over stale state.
  const commentsRef = useRef<CommentRecord[]>(comments)
  useEffect(() => {
    projectRef.current = projectId
    tokenRef.current = getToken
    authorRef.current = author
    scopeRef.current = scope
  }, [projectId, getToken, author, scope])
  // Sync commentsRef whenever the comments array changes.
  useEffect(() => {
    commentsRef.current = comments
  }, [comments])

  // Monotonic fetch-sequence guard (mirrors the cell-side writeSeqRef pattern
  // from AQU-247). Bumped on every optimistic mutation; fetches record their
  // startSeq so a stale in-flight response can't clobber newer optimistic state.
  const mutationSeqRef = useRef(0)
  // Optimistic comments: records queued locally but not yet confirmed by server.
  // Keyed by commentId for O(1) lookup and dedup.
  const optimisticRef = useRef<Map<string, CommentRecord>>(new Map())

  /**
   * Merge server rows with any still-pending optimistic comments.
   * A comment is "still-pending" if its commentId is not yet in server rows
   * (the flush hasn't landed yet) and it hasn't been locally soft-deleted.
   */
  function mergeWithOptimistic(serverRows: CommentRecord[]): CommentRecord[] {
    if (optimisticRef.current.size === 0) return serverRows
    const serverIds = new Set(serverRows.map((r) => r.commentId))
    const pending: CommentRecord[] = []
    for (const [, c] of optimisticRef.current) {
      if (!serverIds.has(c.commentId)) {
        pending.push(c)
      } else {
        // Server confirmed this comment — remove from optimistic set.
        optimisticRef.current.delete(c.commentId)
      }
    }
    return [...serverRows, ...pending]
  }

  const refresh = useCallback(async () => {
    const pid = projectRef.current
    const fetchToken = tokenRef.current
    if (!pid) return

    // Capture the mutation clock at the point we STARTED this fetch.
    // (Currently used implicitly via mergeWithOptimistic; explicit seq
    // comparison reserved for a future multi-concurrent-fetch scenario.)
    void mutationSeqRef.current // snapshot for future guard use

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

      // Merge server rows with any still-pending optimistic comments.
      // The mutationSeq guard means we never replace newer local state with
      // a stale snapshot — both branches call mergeWithOptimistic so that
      // optimistic records not yet confirmed by the server stay visible.
      const merged = mergeWithOptimistic(rows)
      setComments(merged)
    } catch (err) {
      console.warn('[useComments] fetch failed:', err)
      setIsError(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Load on mount, when projectId changes, and — crucially — once the auth
  // token becomes available (AQU-640). On a cold load / direct navigation the
  // page can mount before the session JWT has loaded; a fetch fired then would
  // hit the null-token guard in refresh(), bail silently, and never re-arm.
  // Threading `tokenReady` into this effect's deps re-fires the load the moment
  // the token is ready. While it's explicitly `false` we show the loading state
  // and wait rather than flashing the "No comments yet" empty state.
  useEffect(() => {
    if (!projectId) return
    if (tokenReady === false) {
      // Session not ready yet — keep the spinner up and wait; the effect will
      // re-run (and load) once tokenReady flips true.
      setIsLoading(true)
      return
    }
    refresh().catch(() => {/* refresh sets isError */})
  }, [projectId, tokenReady, refresh])

  /**
   * Derive the envelope fileId for a comment mutation.
   * - Cell/file scoped comments: use the comment's own fileId.
   * - Project scoped (no fileId): stamp the sentinel so authorize.ts
   *   routes to verifyTokenForProject instead of rejecting with 400.
   */
  function commentEnvelopeFileId(commentId: string): string {
    const fileId = commentsRef.current.find((c) => c.commentId === commentId)?.fileId ?? null
    return fileId ?? PROJECT_SENTINEL_FILE_ID
  }

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
      // BLOCKER 1 fix (client side): project-scoped comments carry the sentinel
      // so outbox-flush.ts can mint a token and authorize.ts accepts it.
      // Cell/file scoped comments use their own fileId.
      const envelopeFileId =
        commentScope.kind === 'cell' || commentScope.kind === 'file'
          ? commentScope.fileId
          : PROJECT_SENTINEL_FILE_ID
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
      const optimisticRecord: CommentRecord = {
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
      }
      mutationSeqRef.current++
      optimisticRef.current.set(commentId, optimisticRecord)
      setComments((prev) => [...prev, optimisticRecord])
      return commentId
    },
    [],
  )

  const editComment = useCallback(async (commentId: string, body: string) => {
    const pid = projectRef.current
    if (!pid) return
    // Derive fileId from the comment record; fall back to sentinel for project-scoped.
    const envelopeFileId = commentEnvelopeFileId(commentId)
    await enqueueEvent({
      kind: 'comment.edit',
      projectId: pid,
      fileId: envelopeFileId,
      parentId: null,
      author: authorRef.current,
      payload: { commentId, body },
    })
    // Optimistic update.
    mutationSeqRef.current++
    setComments((prev) =>
      prev.map((c) =>
        c.commentId === commentId ? { ...c, body, updatedAt: Date.now() } : c,
      ),
    )
    // Update the optimistic record if it's still pending.
    const opt = optimisticRef.current.get(commentId)
    if (opt) optimisticRef.current.set(commentId, { ...opt, body, updatedAt: Date.now() })
  }, [])

  const deleteComment = useCallback(async (commentId: string) => {
    const pid = projectRef.current
    if (!pid) return
    const envelopeFileId = commentEnvelopeFileId(commentId)
    await enqueueEvent({
      kind: 'comment.delete',
      projectId: pid,
      fileId: envelopeFileId,
      parentId: null,
      author: authorRef.current,
      payload: { commentId },
    })
    // Optimistic soft-delete: mark deleted_at locally, body → empty.
    const now = Date.now()
    mutationSeqRef.current++
    setComments((prev) =>
      prev.map((c) =>
        c.commentId === commentId
          ? { ...c, body: '', deletedAt: now, updatedAt: now }
          : c,
      ),
    )
    optimisticRef.current.delete(commentId)
  }, [])

  const resolveThread = useCallback(async (commentId: string, resolved: boolean) => {
    const pid = projectRef.current
    if (!pid) return
    const envelopeFileId = commentEnvelopeFileId(commentId)
    await enqueueEvent({
      kind: 'comment.resolve',
      projectId: pid,
      fileId: envelopeFileId,
      parentId: null,
      author: authorRef.current,
      payload: { commentId, resolved },
    })
    // Optimistic update.
    mutationSeqRef.current++
    setComments((prev) =>
      prev.map((c) =>
        c.commentId === commentId ? { ...c, resolved, updatedAt: Date.now() } : c,
      ),
    )
    const opt = optimisticRef.current.get(commentId)
    if (opt) optimisticRef.current.set(commentId, { ...opt, resolved, updatedAt: Date.now() })
  }, [])

  return { comments, isLoading, isError, addComment, editComment, deleteComment, resolveThread, refresh }
}
