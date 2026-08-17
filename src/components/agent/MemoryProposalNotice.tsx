/**
 * MemoryProposalNotice.tsx — inline notices for `memory.proposed` and
 * `brief.proposed` (AQU-AGENT §2 propose_memory / propose_brief_update,
 * §4 frames). Review/approve lives in the Memory tab (W1E's
 * src/components/agent/memory/AgentMemoryTab.tsx) — these notices are
 * read-only in chat, with an optional jump-to-tab affordance.
 */

import { ArrowRight, BookMarked, Check, FileText } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import type { BriefProposedItem, MemoryProposedItem } from "@/lib/agent/run-state"

function ReviewLink({ onClick }: { onClick?: () => void }) {
  const t = useT()
  if (!onClick) return null
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1 font-medium text-sky-600 hover:underline dark:text-sky-400"
    >
      {t("agent.memory.reviewInMemoryTab")}
      <ArrowRight className="h-3 w-3" />
    </button>
  )
}

/** mem-M5: once the Memory tab reviews this proposal, session-store's
 *  markMemoryReviewed/markBriefReviewed flips `item.status` to "reviewed" —
 *  the jump link no longer makes sense, so it's replaced by a settled badge. */
function ReviewedBadge() {
  const t = useT()
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-medium text-muted-foreground">
      <Check className="h-3 w-3" />
      {t("agent.memory.reviewed")}
    </span>
  )
}

export function MemoryProposalNotice({
  item,
  onReviewMemory,
}: {
  item: MemoryProposedItem
  /** Switches AgentWorkbench to the Memory tab. Omitted where there's no tab to jump to. */
  onReviewMemory?: () => void
}) {
  const reviewed = item.status === "reviewed"
  return (
    <div
      data-frame-type="memory.proposed"
      data-memory-path={item.path}
      data-status={item.status ?? "pending"}
      className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-[11px]"
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <RichMessage
          k="agent.memory.proposedNotice"
          values={{
            path: <span className="font-mono">{item.path}</span>,
            preview: item.preview,
          }}
        />
      </span>
      {reviewed ? <ReviewedBadge /> : <ReviewLink onClick={onReviewMemory} />}
    </div>
  )
}

export function BriefProposalNotice({
  item,
  onReviewMemory,
}: {
  item: BriefProposedItem
  onReviewMemory?: () => void
}) {
  const t = useT()
  const reviewed = item.status === "reviewed"
  return (
    <div
      data-frame-type="brief.proposed"
      data-status={item.status ?? "pending"}
      className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-[11px]"
    >
      <BookMarked className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">{t("agent.memory.briefProposedNotice", { preview: item.preview })}</span>
      {reviewed ? <ReviewedBadge /> : <ReviewLink onClick={onReviewMemory} />}
    </div>
  )
}
