// Project-wide comments page. Shows all threaded comments across every scope,
// grouped by file/cell. Resolved threads are collapsed by default.
//
// Uses the v3 event-log backed useComments hook (comment.* event grammar).

import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, MessageCircle, CheckCircle, ChevronDown, ChevronRight, Loader2, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { useComments } from "@/hooks/useComments"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { useProject } from "@/hooks/useProject"

// ── Helpers ───────────────────────────────────────────────────────────────

function formatTs(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  } catch {
    return String(ms)
  }
}

function scopeLabel(comment: CommentRecord): string {
  if (comment.scopeKind === "cell") {
    return `Cell ${comment.cellId ?? "?"} in ${comment.fileId ?? "?"}`
  }
  if (comment.scopeKind === "file") {
    return `File ${comment.fileId ?? "?"}`
  }
  return "Project"
}

// ── Single comment bubble ─────────────────────────────────────────────────

function CommentBubble({ comment }: { comment: CommentRecord }) {
  const isDeleted = comment.deletedAt !== null

  return (
    <div className={cn("flex flex-col gap-0.5", comment.parentCommentId ? "pl-6" : "")}>
      <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{comment.authorLabel ?? comment.authorId}</span>
        <span>{formatTs(comment.createdAt)}</span>
        {comment.updatedAt !== comment.createdAt && (
          <span className="italic">(edited)</span>
        )}
      </div>
      {isDeleted ? (
        <p className="italic text-xs text-muted-foreground">[deleted]</p>
      ) : (
        <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
      )}
    </div>
  )
}

// ── Thread (top-level + replies) ─────────────────────────────────────────

interface ThreadProps {
  root: CommentRecord
  replies: CommentRecord[]
  onResolve: (commentId: string, resolved: boolean) => void
}

function CommentThreadCard({ root, replies, onResolve }: ThreadProps) {
  const [open, setOpen] = useState(!root.resolved)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className={cn("mb-3 overflow-hidden", root.resolved && "opacity-70")}>
        <CardHeader className="flex flex-row items-start gap-2 space-y-0 py-2 px-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-0.5">
              <span className="truncate">{scopeLabel(root)}</span>
              {root.resolved && (
                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                  <CheckCircle className="mr-0.5 h-2.5 w-2.5" />
                  resolved
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => onResolve(root.commentId, !root.resolved)}
            >
              {root.resolved ? "Reopen" : "Resolve"}
            </Button>
            <CollapsibleTrigger asChild>
              <Button size="icon" variant="ghost" className="h-6 w-6">
                {open ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </Button>
            </CollapsibleTrigger>
          </div>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="pt-0 px-3 pb-3 flex flex-col gap-3">
            <CommentBubble comment={root} />
            {replies.map((r) => (
              <CommentBubble key={r.commentId} comment={r} />
            ))}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────

export function CommentsPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { session } = useFrontierSession()
  const { project } = useProject(projectId ?? null)

  const getToken = useMemo(() => {
    if (!projectId || !session?.jwt) {
      return async (_fileId: string) => null as string | null
    }
    return buildFileScopedTokenFetcher(
      () => session.jwt,
      projectId,
    )
  }, [projectId, session?.jwt])

  const { comments, isLoading, isError, resolveThread, refresh } = useComments({
    projectId: projectId ?? null,
    getToken,
    author: session?.username ?? 'unknown',
  })

  // Separate top-level threads from replies.
  const { roots, repliesByParent } = useMemo(() => {
    const roots: CommentRecord[] = []
    const repliesByParent = new Map<string, CommentRecord[]>()
    for (const c of comments) {
      if (c.parentCommentId === null) {
        roots.push(c)
      } else {
        const arr = repliesByParent.get(c.parentCommentId) ?? []
        arr.push(c)
        repliesByParent.set(c.parentCommentId, arr)
      }
    }
    // Sort roots: unresolved first, then by createdAt DESC (newest open thread first).
    roots.sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? 1 : -1
      return b.createdAt - a.createdAt
    })
    return { roots, repliesByParent }
  }, [comments])

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${projectId}`)}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to project
        </Button>
        <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading}>
          {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <MessageCircle className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">
          {project?.name ? `${project.name} — ` : ""}Comments
        </h1>
        {comments.length > 0 && (
          <Badge variant="secondary">{comments.length}</Badge>
        )}
      </div>

      {isError && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Failed to load comments. Check your connection and try refreshing.
          </CardContent>
        </Card>
      )}

      {isLoading && roots.length === 0 && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && !isError && roots.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <MessageCircle className="h-10 w-10 text-muted-foreground" />
            <div className="text-lg font-medium">No comments yet</div>
            <p className="max-w-md text-sm text-muted-foreground">
              Comments can be added from the cell menu in the editor.
            </p>
          </CardContent>
        </Card>
      )}

      {roots.length > 0 && (
        <div>
          {roots.map((root) => (
            <CommentThreadCard
              key={root.commentId}
              root={root}
              replies={repliesByParent.get(root.commentId) ?? []}
              onResolve={resolveThread}
            />
          ))}
        </div>
      )}
    </div>
  )
}
