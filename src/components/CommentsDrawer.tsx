import { useState } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { CommentThread } from "./CommentThread"

interface CommentsDrawerProps {
  project: ProjectRecord
  cell: CellData
  onClose: () => void
  onNewThread: (firstMessage: string) => void
  onReply: (threadId: string, text: string) => void
  onResolve: (threadId: string, closingMessage?: string) => void
  onReopen: (threadId: string) => void
}

export function CommentsDrawer({ project, cell, onClose, onNewThread, onReply, onResolve, onReopen }: CommentsDrawerProps) {
  const [newThreadText, setNewThreadText] = useState("")
  const permissions = useProjectPermissions(project)

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
    <div className="neu-flat relative z-10 flex h-full w-96 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-sm font-semibold">
          Comments {cell.context && <span className="text-muted-foreground">· {cell.context}</span>}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
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
        {cell.threads.length === 0 ? (
          <p className="text-xs text-muted-foreground">No comments yet.</p>
        ) : (
          cell.threads.map((thread) => (
            <CommentThread
              key={thread.id}
              thread={thread}
              currentTranslated={cell.translated}
              canReply={permissions.canEditComments}
              canResolve={permissions.canResolveComments}
              onReply={(text) => onReply(thread.id, text)}
              onResolve={(msg) => onResolve(thread.id, msg)}
              onReopen={() => onReopen(thread.id)}
            />
          ))
        )}
      </div>

      {permissions.canEditComments ? (
        <div className="border-t p-3 space-y-1.5">
          <p className="text-xs font-medium">New thread</p>
          <textarea
            value={newThreadText}
            onChange={(e) => setNewThreadText(e.target.value)}
            onKeyDown={handleNewThreadKeyDown}
            placeholder="Start a new comment thread..."
            rows={2}
            className="neu-inset w-full resize-none rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button size="sm" onClick={handleCreate} disabled={!newThreadText.trim()} className="w-full">
            Post
          </Button>
        </div>
      ) : !permissions.canResolveComments ? (
        <div className="border-t p-3">
          <p className="text-xs text-muted-foreground">Read-only (imported from git)</p>
        </div>
      ) : null}
    </div>
  )
}
