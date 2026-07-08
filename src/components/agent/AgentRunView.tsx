/**
 * AgentRunView.tsx — ordered timeline for one translation-agent run.
 *
 * Renders the user's prompt, then the run's TimelineItems IN ARRIVAL ORDER:
 * streamed prose (markdown), collapsed tool chips exactly where the model
 * called them, and proposal cards where they were staged (rendered through
 * the renderProposal/renderAquiferProposal seams so Apply wiring stays in the
 * parent). Usage/cost, progress, and running/error/capped states follow.
 */

import { useState, type ReactNode } from "react"
import {
  AlertTriangle,
  Book,
  BookOpen,
  Check,
  ChevronRight,
  Database,
  FileText,
  Loader2,
  PenLine,
  Quote,
  Search,
  Send,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { ChatMarkdown } from "@/components/chat/ChatMarkdown"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent } from "@/components/ui/message"
import { Spinner } from "@/components/ui/spinner"
import type { AgentProposal, AquiferPublishProposal } from "@/lib/agent/protocol"
import type { AgentRunUi, ToolItem, ToolKind } from "@/lib/agent/run-state"

const TOOL_ICON: Record<ToolKind, typeof Database> = {
  sql: Database,
  emit: Send,
  docs: FileText,
  aquifer: Book,
  read: BookOpen,
  examples: Quote,
  search: Search,
  draft: PenLine,
}

const TOOL_LABEL: Record<ToolKind, string> = {
  sql: "sql",
  emit: "stage",
  docs: "docs",
  aquifer: "Bible reference",
  read: "read",
  examples: "examples",
  search: "search",
  draft: "draft",
}

function ToolChip({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[item.tool] ?? Database
  return (
    <div className="rounded-md border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px]"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-mono text-muted-foreground">{TOOL_LABEL[item.tool] ?? item.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{item.summary}</span>
        {item.ok === undefined ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" aria-label="Step running" />
        ) : item.ok ? (
          <Check className="h-3 w-3 shrink-0 text-emerald-600" aria-label="Step succeeded" />
        ) : (
          <X className="h-3 w-3 shrink-0 text-destructive" aria-label="Step failed" />
        )}
      </button>
      {open && item.resultSummary !== undefined && (
        <pre className="overflow-x-auto border-t px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {item.resultSummary}
        </pre>
      )}
    </div>
  )
}

function formatCost(costCents: number): string {
  return `$${(costCents / 100).toFixed(costCents < 10 ? 4 : 2)}`
}

export interface AgentRunViewProps {
  run: AgentRunUi
  /** Renders a staged event-proposal inline where it arrived. The parent owns
   *  Apply wiring; omitted → proposals are skipped (pure previews/tests). */
  renderProposal?: (proposal: AgentProposal) => ReactNode
  /** Same seam for Bible Aquifer publish proposals. */
  renderAquiferProposal?: (proposal: AquiferPublishProposal) => ReactNode
}

export function AgentRunView({ run, renderProposal, renderAquiferProposal }: AgentRunViewProps) {
  return (
    <div className="flex flex-col gap-2">
      {/* User prompt — right-aligned primary bubble. */}
      <Message align="end">
        <MessageContent>
          <Bubble>
            <BubbleContent>{run.prompt}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>

      {run.items.map((item) => {
        switch (item.kind) {
          case "text":
            // Ghost bubble keeps long-form markdown aligned with the column
            // at full width instead of a cramped framed bubble.
            return item.text.trim() ? (
              <Message key={item.id} align="start">
                <MessageContent>
                  <Bubble variant="ghost">
                    <BubbleContent>
                      <ChatMarkdown content={item.text} />
                    </BubbleContent>
                  </Bubble>
                </MessageContent>
              </Message>
            ) : null
          case "tool":
            return <ToolChip key={item.id} item={item} />
          case "proposal":
            return renderProposal ? (
              <div key={item.id}>{renderProposal(item.proposal)}</div>
            ) : null
          case "aquifer":
            return renderAquiferProposal ? (
              <div key={item.id}>{renderAquiferProposal(item.proposal)}</div>
            ) : null
        }
      })}

      {run.status === "running" && (
        <Marker role="status">
          <MarkerIcon>
            <Spinner />
          </MarkerIcon>
          <MarkerContent>
            {run.progress
              ? `${run.progress.label} — ${run.progress.done}/${run.progress.total}`
              : "Agent working…"}
          </MarkerContent>
        </Marker>
      )}

      {run.status === "error" && (
        <Marker role="alert" className="text-destructive">
          <MarkerIcon>
            <AlertTriangle />
          </MarkerIcon>
          <MarkerContent>{run.errorMessage || "Agent run failed."}</MarkerContent>
        </Marker>
      )}

      {run.status === "capped" && (
        <Marker role="status" className="text-amber-700 dark:text-amber-400">
          <MarkerIcon>
            <AlertTriangle />
          </MarkerIcon>
          <MarkerContent>Run hit its step/token cap — results may be partial.</MarkerContent>
        </Marker>
      )}

      {run.usage && (
        <div className="text-[10px] text-muted-foreground">
          {run.usage.promptTokens.toLocaleString()} prompt + {run.usage.completionTokens.toLocaleString()} completion tokens
          {" · "}
          {formatCost(run.usage.costCents)}
        </div>
      )}
    </div>
  )
}
