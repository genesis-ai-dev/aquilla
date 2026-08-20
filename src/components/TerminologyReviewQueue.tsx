/**
 * TerminologyReviewQueue — shows draft concepts awaiting approval.
 *
 * Each row exposes Approve (draft→active) and Reject (delete) actions gated
 * by the canManage prop. Read-only view for below-floor users.
 */

import { CheckCircle, XCircle, ChevronDown, ChevronUp } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { Concept } from "@/lib/terminology/types"
import { renderingStatusLabelKey } from "@/lib/terminology/types"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"

// ── Types ──────────────────────────────────────────────────────────────────

interface ReviewQueueProps {
  draftConcepts: Concept[]
  canManage: boolean
  onApprove: (id: string) => Promise<void>
  onReject: (id: string) => Promise<void>
}

// ── Helpers ────────────────────────────────────────────────────────────────

function RenderingList({ concept }: { concept: Concept }) {
  const t = useT()
  if (concept.renderings.length === 0) {
    return (
      <span className="text-xs text-muted-foreground italic">
        {t("terminology.common.noRenderings")}
      </span>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {concept.renderings.map((r, i) => (
        <span
          key={i}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
            r.status === "preferred" &&
              "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
            r.status === "admitted" && "bg-muted text-muted-foreground",
            r.status === "forbidden" &&
              "bg-red-100 text-red-700 line-through dark:bg-red-950 dark:text-red-400",
          )}
        >
          {r.rendering}
          <span className="opacity-60">·{t(renderingStatusLabelKey(r.status))}</span>
        </span>
      ))}
    </div>
  )
}

interface QueueRowProps {
  concept: Concept
  canManage: boolean
  onApprove: (id: string) => Promise<void>
  onReject: (id: string) => Promise<void>
}

function QueueRow({ concept, canManage, onApprove, onReject }: QueueRowProps) {
  const t = useT()
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null)

  async function handleApprove() {
    setBusy("approve")
    try {
      await onApprove(concept.id)
    } finally {
      setBusy(null)
    }
  }

  async function handleReject() {
    setBusy("reject")
    try {
      await onReject(concept.id)
    } finally {
      setBusy(null)
    }
  }

  return (
    <li
      data-testid="queue-row"
      className="flex items-start gap-3 border-b py-3 last:border-0"
    >
      {/* Source term */}
      <div className="min-w-0 w-36 shrink-0">
        <span className="text-sm font-medium">{concept.sourceTerm}</span>
      </div>

      {/* Renderings */}
      <div className="flex flex-1 min-w-0 flex-col gap-1">
        <RenderingList concept={concept} />
        {concept.notes && (
          <p className="text-xs text-muted-foreground truncate">{concept.notes}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1">
        {canManage ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("terminology.reviewQueue.approveAria", { term: concept.sourceTerm })}
              disabled={busy !== null}
              onClick={handleApprove}
              className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
            >
              <CheckCircle className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("terminology.reviewQueue.rejectAria", { term: concept.sourceTerm })}
              disabled={busy !== null}
              onClick={handleReject}
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <XCircle className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="text-xs text-muted-foreground" />}>
              {t("common.readOnly")}
            </TooltipTrigger>
            <TooltipContent>{t("terminology.reviewQueue.readOnlyTooltip")}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </li>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export function TerminologyReviewQueue({
  draftConcepts,
  canManage,
  onApprove,
  onReject,
}: ReviewQueueProps) {
  const t = useT()
  const [collapsed, setCollapsed] = useState(false)

  if (draftConcepts.length === 0) {
    return (
      <div
        data-testid="review-queue-empty"
        className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground"
      >
        <CheckCircle className="h-6 w-6 opacity-40" />
        <p className="text-sm">{t("terminology.reviewQueue.emptyTitle")}</p>
        <p className="text-xs">{t("terminology.reviewQueue.emptyDescription")}</p>
      </div>
    )
  }

  return (
    <div data-testid="review-queue">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 pb-3 text-sm font-medium text-start"
        aria-expanded={!collapsed}
      >
        <Badge variant="secondary" className="tabular-nums">
          {draftConcepts.length}
        </Badge>
        <span>
          {t("terminology.reviewQueue.awaitingReviewCount", { count: draftConcepts.length })}
        </span>
        {collapsed ? (
          <ChevronDown className="ms-auto h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="ms-auto h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <ul>
          {draftConcepts.map((c) => (
            <QueueRow
              key={c.id}
              concept={c}
              canManage={canManage}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
