import { useState } from "react"
import { AlertCircle, ArrowUp, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, CommentThread as CommentThreadType } from "@/lib/parsers/types"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { canMutateComment, commentFloorsFrom } from "@/lib/sync/role-policy"
import { denialMessage } from "@/lib/permissions/denial"
import { ROLE, resolveRoleName } from "@/lib/frontier/roles"
import { CommentThread } from "./CommentThread"
import { MentionTextarea } from "./MentionTextarea"
import type { MentionCandidate } from "@/lib/comments/mention-suggest"
import { RightSidebarPanel } from "./RightSidebarPanel"
import { useT } from "@/lib/i18n/I18nProvider"

interface CommentsDrawerProps {
  project: ProjectRecord
  cell: CellData
  /** When provided, overrides cell.threads (which useCells leaves empty) */
  liveComments?: CommentRecord[]
  onClose: () => void
  onNewThread: (firstMessage: string) => void
  onReply: (threadId: string, text: string) => void
  onResolve: (threadId: string, closingMessage?: string) => void
  onReopen: (threadId: string) => void
  onEdit?: (commentId: string, body: string) => void
  onDelete?: (commentId: string) => void
  /**
   * AQU-1000: the signed-in user's username, matched against each thread's
   * root `authorId` to tell "my thread" from "someone else's" — the two carry
   * different resolve floors. Absent (local/git project, no session) → the
   * per-thread gate falls open and behaves exactly as before.
   */
  currentUsername?: string | null
  /**
   * AQU-1275: the comments feed failed to load. The drawer used to render the
   * "No comments yet." empty state in this case, so a dropped request looked
   * exactly like a cell whose threads had been deleted — the shape of the
   * Pattani Malay report. Say the load failed and offer a retry instead.
   */
  isError?: boolean
  /**
   * AQU-1275: later pages of the project-wide comment list are still arriving.
   * A cell whose threads haven't paged in yet is not an empty cell, so hold the
   * empty state until the load finishes.
   */
  isLoadingRest?: boolean
  /** Re-runs the comments load; wired to the error state's Retry button. */
  onRetry?: () => void
  /** Project members the @mention picker may name. The drawer does not fetch them. */
  mentionRoster?: readonly MentionCandidate[]
  /**
   * Scroll this comment into view and highlight it. A notification click names
   * the reply; opening the cell from its comment badge does not.
   */
  focusCommentId?: string | null
}

/** Convert flat CommentRecord[] (event-log model) → CommentThread[] (legacy cell model) */
function recordsToThreads(records: CommentRecord[]): CommentThreadType[] {
  // Group: root comments become threads, replies nest inside
  const byId = new Map<string, CommentRecord>()
  for (const r of records) byId.set(r.commentId, r)

  const roots = records.filter((r) => !r.parentCommentId)
  return roots.map((root) => {
    const replies = records.filter((r) => r.parentCommentId === root.commentId)
    return {
      id: root.commentId,
      status: root.resolved ? "resolved" : "open",
      createdAt: new Date(root.createdAt).toISOString(),
      resolvedAt: root.resolved ? new Date(root.updatedAt).toISOString() : undefined,
      // AQU-692: populate the real target-text snapshot captured at thread
      // creation. Missing (older worker / legacy thread) → null = unknown
      // baseline, so CommentThread shows no stale badge instead of a false one.
      createdForTranslated: root.createdForTranslated ?? null,
      // AQU-1000: carry the root author's identity, not just their display
      // label. Resolve is gated on WHO started the thread, and `messages[].author`
      // is `authorLabel ?? authorId` — ambiguous, and unusable for a comparison.
      authorId: root.authorId,
      messages: [root, ...replies].map((r) => ({
        id: r.commentId,
        author: r.authorLabel ?? r.authorId,
        authorType: "user" as const,
        text: r.deletedAt ? "[deleted]" : r.body,
        timestamp: new Date(r.createdAt).toISOString(),
        editedAt:
          !r.deletedAt && r.updatedAt !== r.createdAt
            ? new Date(r.updatedAt).toISOString()
            : undefined,
      })),
    } satisfies CommentThreadType
  })
}

export function CommentsDrawer({ project, cell, liveComments, onClose, onNewThread, onReply, onResolve, onReopen, onEdit, onDelete, currentUsername, isError = false, isLoadingRest = false, onRetry, mentionRoster = [], focusCommentId = null }: CommentsDrawerProps) {
  const t = useT()
  const [newThreadText, setNewThreadText] = useState("")
  const permissions = useProjectPermissions(project)
  // Use liveComments (from useComments hook) when available; fall back to cell.threads
  const threads = liveComments !== undefined ? recordsToThreads(liveComments) : cell.threads

  // AQU-427: for cloud projects, gate comment creation by syncRole level so a
  // viewer (100) doesn't see the "New thread" input only to have the server
  // reject it. The legacy ProjectPermissions path (git-imported) is preserved
  // via `permissions.canEditComments`. Cloud projects have no `project.permissions`
  // object so resolvePermissions returns the full defaults — we must also check
  // the live syncRole.
  const roleLevel = project.syncRole?.level ?? null
  // AQU-1002: the org's configurable floors, off the project record. Absent
  // (list endpoint, older server, local project) ⇒ the stock defaults, so this
  // is a no-op for every org that hasn't set a policy.
  const floors = commentFloorsFrom(project)
  const cloudCanComment = canMutateComment("comment.create", roleLevel, true, floors)
  const cloudCanResolve = canMutateComment("comment.resolve", roleLevel, true, floors)
  // When a syncRole is present, let it take precedence; fall back to legacy permissions.
  const canComment = roleLevel !== null ? cloudCanComment : permissions.canEditComments
  // The role floor for resolving YOUR OWN thread. Whether it also covers a
  // given thread depends on who wrote that thread — decided per row below.
  const canResolveOwn = roleLevel !== null ? cloudCanResolve : permissions.canResolveComments
  // Build a helpful denial message for viewers who cannot comment.
  // AQU-1002: name the org's configured create floor, not the static one, so
  // the sentence matches the bar the server will actually apply.
  const commentDenialReason = !canComment
    ? denialMessage(t, floors.createMinRole, roleLevel)
    : null

  // AQU-1000: resolve authority is per THREAD, not per user. The server
  // re-checks the thread's author and 403s a foreign resolve below the foreign
  // floor; because the client flips `resolved` optimistically, offering the
  // control anyway made the thread close and then spring back open. Decide up
  // front instead, and when the answer is no, say why.
  // AQU-1002: the floor named in the denial sentence is the org's configured
  // one, so the message matches the refusal the server would actually give.
  const foreignResolveFloor = floors.resolveMinRole
  function resolveGateFor(thread: CommentThreadType): { canResolve: boolean; reason: string | null } {
    if (roleLevel === null) {
      // Local / git-imported project: no sync role to reason about, so keep the
      // legacy behaviour verbatim rather than inventing a denial.
      return { canResolve: canResolveOwn, reason: null }
    }
    // An unknown author (legacy thread with no authorId) is treated as foreign:
    // the server will compare against a real author_id we cannot see, so the
    // safe, honest answer is the higher floor.
    const isOwnThread = currentUsername != null && thread.authorId === currentUsername
    if (canMutateComment("comment.resolve", roleLevel, isOwnThread, floors)) {
      return { canResolve: true, reason: null }
    }
    if (!canResolveOwn) {
      // Below even the self floor — this is the plain "your role can't do this"
      // case, same sentence the composer denial uses.
      return { canResolve: false, reason: denialMessage(t, ROLE.COMMENTER, roleLevel) }
    }
    return {
      canResolve: false,
      reason: t("comments.resolve.foreignDenied", {
        minRole: resolveRoleName(t, foreignResolveFloor, { plural: true }),
      }),
    }
  }

  function canMutateThread(kind: "comment.edit" | "comment.delete", thread: CommentThreadType): boolean {
    if (roleLevel === null) return permissions.canEditComments
    const isOwn = currentUsername != null && thread.authorId === currentUsername
    return canMutateComment(kind, roleLevel, isOwn, floors)
  }

  function handleCreate() {
    if (!newThreadText.trim()) return
    onNewThread(newThreadText)
    setNewThreadText("")
  }

  function handleNewThreadKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    handleCreate()
  }

  return (
    <RightSidebarPanel storageKey="comments" defaultWidth={384} resizeLabel="Resize comments panel">
    <div className="bg-card relative z-10 flex h-full w-full flex-col border-s" data-testid="comments-drawer">
      <div className="flex items-center justify-between border-b p-2">
        <h3 className="text-sm font-semibold">
          {t("common.comments")} {cell.context && <span className="text-muted-foreground">· {cell.context}</span>}
        </h3>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("comments.drawer.closeLabel")}>
          <X />
        </Button>
      </div>

      <div className="border-b px-3 py-2 text-xs">
        <div className="text-muted-foreground">{t("editor.column.source")}</div>
        <div className="mt-0.5">{cell.original}</div>
        {cell.translated && (
          <>
            <div className="mt-1.5 text-muted-foreground">{t("editor.column.target")}</div>
            <div className="mt-0.5">{cell.translated}</div>
          </>
        )}
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-2" data-comments-scroll="">
        {/*
          AQU-1275: a failed or half-finished load must never read as "this cell
          has no comments". The error banner stays above whatever threads did
          land, because a partial list is also untrustworthy — the reporter saw
          verses 1–13 while 14–48 silently vanished.
        */}
        {isError && (
          <div
            className="flex items-start gap-2 rounded-md border border-destructive p-2 text-xs text-destructive"
            data-testid="comments-drawer-error"
            role="status"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="space-y-1.5">
              <p>{t("comments.drawer.loadError")}</p>
              {onRetry && (
                <Button variant="outline" size="sm" onClick={onRetry} className="h-6 px-2 text-xs">
                  {t("common.retry")}
                </Button>
              )}
            </div>
          </div>
        )}
        {threads.length === 0 ? (
          isError ? null : isLoadingRest ? (
            <p className="text-xs text-muted-foreground" data-testid="comments-drawer-loading">
              {t("common.loading")}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{t("comments.drawer.noComments")}</p>
          )
        ) : (
          threads.map((thread) => {
            const gate = resolveGateFor(thread)
            return (
              <CommentThread
                key={thread.id}
                thread={thread}
                currentTranslated={cell.translated}
                canReply={canComment}
                canResolve={gate.canResolve}
                resolveDenialReason={gate.reason}
                onReply={(text) => onReply(thread.id, text)}
                onResolve={(msg) => onResolve(thread.id, msg)}
                onReopen={() => onReopen(thread.id)}
                onEdit={(text) => onEdit?.(thread.id, text)}
                onDelete={() => onDelete?.(thread.id)}
                canEdit={canMutateThread("comment.edit", thread)}
                canDelete={canMutateThread("comment.delete", thread)}
                projectId={project.id}
                fileId={cell.fileId}
                cellId={cell.id}
                mentionRoster={mentionRoster}
                currentUsername={currentUsername}
                highlightCommentId={focusCommentId}
              />
            )
          })
        )}

      {canComment ? (
        <div className="relative">
            <MentionTextarea
              value={newThreadText}
              onChange={setNewThreadText}
              onKeyDown={handleNewThreadKeyDown}
              candidates={mentionRoster}
              currentUsername={currentUsername}
              aria-label={t("comments.drawer.newThreadHeading")}
              placeholder={t("comments.drawer.newThreadPlaceholder")}
              rows={2}
              className="resize-none pb-8"
            />
            <div className="absolute end-1.5 bottom-1.5">
              <Button
                type="button"
                size="icon-xs"
                variant={newThreadText.trim() ? "default" : "outline"}
                aria-label={t("comments.drawer.post")}
                onClick={handleCreate}
                disabled={!newThreadText.trim()}
              >
                <ArrowUp />
              </Button>
            </div>
          </div>
      ) : (
        <div>
          {/* AQU-427: show a human-readable denial for roles that cannot comment. */}
          <p className="text-xs text-muted-foreground" data-testid="comments-drawer-denial">
            {commentDenialReason ?? t("common.readOnlyGit")}
          </p>
        </div>
      )}
      </div>
    </div>
    </RightSidebarPanel>
  )
}
