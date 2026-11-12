// Thread card for a comment list — the project Comments page and, since
// AQU-1958, the org-wide comments view.
//
// Extracted from CommentsPage.tsx so both surfaces render a thread identically:
// the org view is the same list with a project label on each root row, so a
// divergence here would be a divergence a reviewer sees between the two pages.

import { MessageCircleCheck } from "lucide-react"
import DOMPurify from "dompurify"
import { Badge } from "@/components/ui/badge"
import { UserChip } from "@/components/UserChip"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { renderCommentHtml } from "@/lib/comments/comment-helpers"
import type { CommentRecord } from "@/lib/sync/comments-read-types"
import { useI18n, type TFunction } from "@/lib/i18n/I18nProvider"
import { resolveFileName } from "./comments-page-filters"
import { formatScriptureRef } from "./comments-cell-preview"

function scopeLabel(comment: CommentRecord, fileMap: Map<string, string>, t: TFunction): string {
  if (comment.scopeKind === "file") {
    const { name } = resolveFileName(comment.fileId, fileMap, t)
    return t("comments.scope.file", { file: name })
  }
  return t("common.project")
}

function CellPlace({
  root,
  place,
  fileMap,
  t,
}: {
  root: CommentRecord
  place?: string
  fileMap: Map<string, string>
  t: TFunction
}) {
  if (root.scopeKind === "cell") {
    const label = place || formatScriptureRef(root.cellRef)
    if (label) return <span className="min-w-0 flex-1 truncate">{label}</span>
    return <span className="min-w-0 flex-1 truncate">{resolveFileName(root.fileId, fileMap, t).name}</span>
  }
  return <span className="min-w-0 flex-1 truncate">{scopeLabel(root, fileMap, t)}</span>
}

export function safeCommentHtml(text: string): string {
  return DOMPurify.sanitize(renderCommentHtml(text), {
    ALLOWED_TAGS: ["b", "i", "code", "br", "span"],
    ALLOWED_ATTR: ["class"],
  })
}

function PageCommentRow({
  comment,
  isRoot,
  fileMissing,
  place,
  fileMap,
  root,
  projectLabel,
  onNavigate,
}: {
  comment: CommentRecord
  isRoot: boolean
  fileMissing: boolean
  place?: string
  fileMap: Map<string, string>
  root: CommentRecord
  projectLabel?: string
  onNavigate?: (comment: CommentRecord) => void
}) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={() => onNavigate?.(comment)}
      disabled={!onNavigate}
      className="block w-full p-2 text-start outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
    >
      {isRoot && (
        <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {/* AQU-1958: which project this thread is in. Only the org-wide view
              passes it — on a project's own page every row would say the same
              thing. The project's display name, never its id (AQU-295). */}
          {projectLabel && (
            <Badge variant="outline" className="h-4 max-w-40 truncate px-1 text-[10px]">
              {projectLabel}
            </Badge>
          )}
          <CellPlace root={root} place={place} fileMap={fileMap} t={t} />
          {fileMissing && (
            <Badge variant="outline" className="h-4 px-1 text-[10px] text-muted-foreground">
              {t("comments.file.deletedBadge")}
            </Badge>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 text-xs">
        <UserChip
          username={comment.authorLabel ?? comment.authorId}
          size="xs"
          nameClassName="text-xs"
        />
        <span className="text-muted-foreground">
          <DateTooltip
            value={comment.createdAt}
            label=""
            variant="ago"
            side="top"
            editedAt={comment.deletedAt ? null : comment.updatedAt}
            editedNotice={t("comments.bubble.edited")}
          />
        </span>
      </div>
      {comment.deletedAt != null ? (
        <p className="mt-1 ps-7 text-sm text-muted-foreground">{t("comments.bubble.deletedBody")}</p>
      ) : (
        <div
          data-ph-mask=""
          className="mt-1 ps-7 text-sm select-text"
          dangerouslySetInnerHTML={{ __html: safeCommentHtml(comment.body) }}
        />
      )}
    </button>
  )
}

export interface CommentThreadCardProps {
  root: CommentRecord
  replies: CommentRecord[]
  fileMap: Map<string, string>
  /** Book, chapter, and verse for this thread's cell, when the read has landed. */
  place?: string
  /** Project name badge on the root row; omitted on a single-project list. */
  projectLabel?: string
  onNavigate?: (root: CommentRecord) => void
}

export function CommentThreadCard({
  root, replies, fileMap, place, projectLabel, onNavigate,
}: CommentThreadCardProps) {
  const { t, locale } = useI18n()

  const messages = [root, ...replies]
  const authors = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    [...new Set(messages.map((message) => message.authorLabel ?? message.authorId))],
  )
  const resolvedSummary = t("comments.thread.resolvedSummary", {
    count: messages.length,
    authors,
  })
  const fileMissing = !!root.fileId && !resolveFileName(root.fileId, fileMap, t).exists

  const threadBody = (
    <ul className="divide-y">
      {messages.map((comment, index) => (
        <li key={comment.commentId}>
          <PageCommentRow
            comment={comment}
            isRoot={index === 0}
            fileMissing={fileMissing}
            place={place}
            fileMap={fileMap}
            root={root}
            projectLabel={projectLabel}
            onNavigate={onNavigate}
          />
        </li>
      ))}
    </ul>
  )

  return root.resolved ? (
    <button
      type="button"
      onClick={() => onNavigate?.(root)}
      disabled={!onNavigate}
      className="flex w-full items-center gap-2 rounded-lg border bg-card p-2 text-start text-sm outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
    >
      <MessageCircleCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      {projectLabel && (
        <Badge variant="outline" className="h-4 max-w-40 shrink-0 truncate px-1 text-[10px]">
          {projectLabel}
        </Badge>
      )}
      <span className="min-w-0 flex-1 truncate">{resolvedSummary}</span>
    </button>
  ) : (
    <div className="rounded-lg border bg-card text-sm">{threadBody}</div>
  )
}
