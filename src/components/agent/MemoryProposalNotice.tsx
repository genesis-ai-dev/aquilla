/**
 * MemoryProposalNotice.tsx — inline notices for `memory.proposed` and
 * `brief.proposed` (AQU-AGENT §2 propose_memory / propose_brief_update,
 * §4 frames). Review/approve lives in the Memory tab (W1E's
 * src/components/agent/memory/AgentMemoryTab.tsx) — these notices are
 * read-only in chat, with an optional jump-to-tab affordance.
 */

import { ArrowRight, BookMarked, FileText } from "lucide-react"
import type { BriefProposedItem, MemoryProposedItem } from "@/lib/agent/run-state"

function ReviewLink({ onClick }: { onClick?: () => void }) {
  if (!onClick) return null
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1 font-medium text-sky-600 hover:underline dark:text-sky-400"
    >
      Review in Memory tab
      <ArrowRight className="h-3 w-3" />
    </button>
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
  return (
    <div
      data-frame-type="memory.proposed"
      data-memory-path={item.path}
      className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-[11px]"
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        Proposed memory <span className="font-mono">{item.path}</span> — {item.preview}
      </span>
      <ReviewLink onClick={onReviewMemory} />
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
  return (
    <div
      data-frame-type="brief.proposed"
      className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-[11px]"
    >
      <BookMarked className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">Proposed brief update — {item.preview}</span>
      <ReviewLink onClick={onReviewMemory} />
    </div>
  )
}
