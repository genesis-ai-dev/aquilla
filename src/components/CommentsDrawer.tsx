import { useState } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, CommentThread as CommentThreadType } from "@/lib/parsers/types"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { canPerform } from "@/lib/sync/role-policy"
import { denialMessage } from "@/lib/permissions/denial"
import { ROLE } from "@/lib/frontier/roles"
import { CommentThread } from "./CommentThread"

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
      createdForTranslated: "",
      messages: [root, ...replies].map((r) => ({
        id: r.commentId,
        author: r.authorLabel ?? r.authorId,
        authorType: "user" as const,
        text: r.deletedAt ? "[deleted]" : r.body,
        timestamp: new Date(r.createdAt).toISOString(),
      })),
    } satisfies CommentThreadType
  })
}

export function CommentsDrawer({ project, cell, liveComments, onClose, onNewThread, onReply, onResolve, onReopen }: CommentsDrawerProps) {
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
  const cloudCanComment = canPerform("comment.create", roleLevel)
  const cloudCanResolve = canPerform("comment.resolve", roleLevel)
  // When a syncRole is present, let it take precedence; fall back to legacy permissions.
  const canComment = roleLevel !== null ? cloudCanComment : permissions.canEditComments
  const canResolve = roleLevel !== null ? cloudCanResolve : permissions.canResolveComments
  // Build a helpful denial message for viewers who cannot comment.
  const commentDenialReason = !canComment
    ? denialMessage(ROLE.COMMENTER, roleLevel)
    : null

  function handleCreate() {
    if (!newThreadText.trim()) return
    onNewThread(newThreadText)
    setNewThreadText("")
  }

  function handleNewThreadKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      handleCreate()
    }
  }

  return (
    <div className="bg-card relative z-10 flex h-full w-96 flex-col border-l" data-testid="comments-drawer">
      <div className="flex items-center justify-between border-b p-2">
        <h3 className="text-sm font-semibold">
          Comments {cell.context && <span className="text-muted-foreground">· {cell.context}</span>}
        </h3>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close comments">
          <X />
        </Button>
      </div>

      <div className="border-b px-3 py-2 text-xs">
        <div className="text-muted-foreground">Source</div>
        <div className="mt-0.5">{cell.original}</div>
        {cell.translated && (
          <>
            <div className="mt-1.5 text-muted-foreground">Target</div>
            <div className="mt-0.5">{cell.translated}</div>
          </>
        )}
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-2">
        {threads.length === 0 ? (
          <p className="text-xs text-muted-foreground">No comments yet.</p>
        ) : (
          threads.map((thread) => (
            <CommentThread
              key={thread.id}
              thread={thread}
              currentTranslated={cell.translated}
              canReply={canComment}
              canResolve={canResolve}
              onReply={(text) => onReply(thread.id, text)}
              onResolve={(msg) => onResolve(thread.id, msg)}
              onReopen={() => onReopen(thread.id)}
            />
          ))
        )}
      </div>

      {canComment ? (
        <div className="border-t p-3 space-y-1.5">
          <p className="text-xs font-medium">New thread</p>
          <Textarea
            value={newThreadText}
            onChange={(e) => setNewThreadText(e.target.value)}
            onKeyDown={handleNewThreadKeyDown}
            placeholder="Start a new comment thread..."
            rows={2}
            className="resize-none"
          />
          <Button size="sm" onClick={handleCreate} disabled={!newThreadText.trim()} className="w-full">
            Post
          </Button>
        </div>
      ) : (
        <div className="border-t p-3">
          {/* AQU-427: show a human-readable denial for roles that cannot comment. */}
          <p className="text-xs text-muted-foreground" data-testid="comments-drawer-denial">
            {commentDenialReason ?? "Read-only (imported from git)"}
          </p>
        </div>
      )}
    </div>
  )
}
