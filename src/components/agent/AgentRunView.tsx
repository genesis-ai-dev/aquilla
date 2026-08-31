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
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import {
  AlertTriangle,
  Check,
  ChevronRight,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { formatCredits } from "@/lib/credits"
import { ChatMarkdown } from "@/components/chat/ChatMarkdown"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent } from "@/components/ui/message"
import { Spinner } from "@/components/ui/spinner"
import type { AgentProposal, AquiferPublishProposal } from "@/lib/agent/protocol"
import type { AgentRunUi, ToolItem, ToolKind } from "@/lib/agent/run-state"
import { splitNextSteps } from "@/lib/agent/suggestions"
import { AGENT_PERSONAS, personaForToolKind } from "@/lib/agent/personas"
import { BudgetMeter } from "./BudgetMeter"
import { ChangesetCard } from "./ChangesetCard"
import { CodeActivityBlock } from "./CodeActivityBlock"
import { BriefProposalNotice, MemoryProposalNotice } from "./MemoryProposalNotice"
import { PersonaAvatar } from "./PersonaAvatar"
import { InlineAiError } from "@/components/InlineAiError"

/** Plain-language sentence per tool kind (social-workspace design): the
 *  collapsed line reads as a teammate's activity, never a command. */
const TOOL_FRIENDLY_KEY: Record<ToolKind, MessageKey> = {
  sql: "agent.run.friendly.sql",
  emit: "agent.run.friendly.emit",
  docs: "agent.run.friendly.docs",
  aquifer: "agent.run.friendly.aquifer",
  read: "agent.run.friendly.read",
  examples: "agent.run.friendly.examples",
  search: "agent.run.friendly.search",
  draft: "agent.run.friendly.draft",
}

function ToolChip({ item }: { item: ToolItem }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const persona = AGENT_PERSONAS[personaForToolKind(item.tool)]
  // Raw SQL is meaningless to a translator — it stays behind the expand.
  // Other kinds carry human summaries (ref ranges, topics, "N events").
  const detail = item.tool === "sql" ? null : item.summary
  const expandable = item.resultSummary !== undefined || item.tool === "sql"
  // Flat by design (v2.1 typical-chat notes): no box around activity — just a
  // quiet row that tints on hover, with the raw detail one expand away.
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-start text-[11px] transition-colors hover:bg-accent/40"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 text-muted-foreground", open && "rotate-90")}
        />
        <PersonaAvatar personaId={persona.id} size="sm" />
        <span className="shrink-0 text-muted-foreground">{t(TOOL_FRIENDLY_KEY[item.tool])}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/80">{detail}</span>
        {item.ok === undefined ? (
          <Spinner className="size-3 shrink-0 text-muted-foreground" aria-label={t("agent.run.stepRunning")} />
        ) : item.ok ? (
          <Check className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("agent.run.stepSucceeded")} />
        ) : (
          <X className="h-3 w-3 shrink-0 text-destructive" aria-label={t("agent.run.stepFailed")} />
        )}
      </button>
      {open && expandable && (
        <pre className="ms-7 mt-0.5 overflow-x-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {item.tool === "sql" && item.summary ? `${item.summary}\n` : ""}
          {item.resultSummary ?? ""}
        </pre>
      )}
    </div>
  )
}

export interface AgentRunViewProps {
  run: AgentRunUi
  /** Renders a staged event-proposal inline where it arrived. The parent owns
   *  Apply wiring; omitted → proposals are skipped (pure previews/tests). */
  renderProposal?: (proposal: AgentProposal) => ReactNode
  /** Same seam for Bible Aquifer publish proposals. */
  renderAquiferProposal?: (proposal: AquiferPublishProposal) => ReactNode
  /** Card-registry seam (agent-complete §4): a rich live card rendered UNDER
   *  a tool chip (e.g. PassageCard for read/draft rows). Null → chip only. */
  renderToolCard?: (item: ToolItem) => ReactNode
  /** Jump to the workbench's Memory tab from a memory/brief proposal notice.
   *  Omitted where there's no Memory tab to jump to (e.g. the dock panel). */
  onReviewMemory?: () => void
  /** Post-commit flush + revalidate for the live ChangesetCard (AQU-926) —
   *  same hook AgentDockView passes to ProposalCard. Omitted → the card
   *  relies on the project DO's event.applied broadcast alone. */
  onChangesetApplied?: (eventIds: string[], cellIds: string[]) => void | Promise<void>
  /** Sends a suggested next step ("NEXT:" lines in the final reply) back as
   *  the next user message. Only the latest run of a conversation gets this —
   *  older runs strip the marker lines but render no buttons. */
  onSuggestionSend?: (text: string) => void
}

export function AgentRunView({
  run,
  renderProposal,
  renderAquiferProposal,
  renderToolCard,
  onReviewMemory,
  onChangesetApplied,
  onSuggestionSend,
}: AgentRunViewProps) {
  const { locale, t } = useI18n()
  // Trailing NEXT: lines live in the LAST prose item; strip them from display
  // there (including mid-stream partials) and surface them as buttons once the
  // run has settled ok.
  let lastTextIndex = -1
  for (let i = run.items.length - 1; i >= 0; i--) {
    if (run.items[i].kind === "text") {
      lastTextIndex = i
      break
    }
  }
  const lastText = lastTextIndex >= 0 ? run.items[lastTextIndex] : null
  const parsed = lastText?.kind === "text" ? splitNextSteps(lastText.text) : null
  const suggestions =
    run.status === "ok" && onSuggestionSend && parsed ? parsed.suggestions.slice(0, 2) : []
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

      {run.items.map((item, index) => {
        switch (item.kind) {
          case "text": {
            const displayText = index === lastTextIndex && parsed ? parsed.body : item.text
            if (!displayText.trim()) return null
            // Discord-style attribution: the Coordinator's name heads each
            // block of prose, re-shown after any interleaved activity.
            const previous = index > 0 ? run.items[index - 1] : null
            const showHeader = previous?.kind !== "text"
            // Ghost bubble keeps long-form markdown aligned with the column
            // at full width instead of a cramped framed bubble.
            return (
              <Message key={item.id} align="start">
                <MessageContent>
                  {showHeader && (
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <PersonaAvatar personaId="coordinator" size="sm" />
                      {/* Monochrome by design: identity lives in the avatar,
                          the name carries hierarchy through weight alone. */}
                      <span className="text-[11px] font-medium text-foreground">
                        {t(AGENT_PERSONAS.coordinator.nameKey)}
                      </span>
                    </div>
                  )}
                  <Bubble variant="ghost">
                    <BubbleContent>
                      <ChatMarkdown content={displayText} />
                    </BubbleContent>
                  </Bubble>
                </MessageContent>
              </Message>
            )
          }
          case "tool": {
            const card = renderToolCard?.(item)
            return (
              <div key={item.id} className="flex flex-col gap-1">
                <ToolChip item={item} />
                {card}
              </div>
            )
          }
          case "proposal":
            return renderProposal ? (
              <div key={item.id}>{renderProposal(item.proposal)}</div>
            ) : null
          case "aquifer":
            return renderAquiferProposal ? (
              <div key={item.id}>{renderAquiferProposal(item.proposal)}</div>
            ) : null
          case "code":
            return <CodeActivityBlock key={item.id} item={item} />
          case "changeset":
            return <ChangesetCard key={item.id} item={item} onApplied={onChangesetApplied} />
          case "memory-proposed":
            return <MemoryProposalNotice key={item.id} item={item} onReviewMemory={onReviewMemory} />
          case "brief-proposed":
            return <BriefProposalNotice key={item.id} item={item} onReviewMemory={onReviewMemory} />
        }
      })}

      {suggestions.length > 0 && (
        // Quiet outline chips, monochrome by design — the model's own "what
        // now?" answers, one tap from becoming the next message.
        <div
          role="group"
          aria-label={t("agent.run.suggestionsAriaLabel")}
          className="flex flex-wrap items-center gap-1.5 ps-1"
        >
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onSuggestionSend?.(text)}
              className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              {text}
            </button>
          ))}
        </div>
      )}

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
          {/* AQU-891: a failed run reports the provider's message verbatim.
              Categorize it so the marker reads as a sentence, and keep the raw
              text one click away (copyable) instead of inline. */}
          <MarkerContent>
            <InlineAiError
              message={run.errorMessage || "Agent run failed."}
              announce={false}
              className="text-inherit"
            />
          </MarkerContent>
        </Marker>
      )}

      {run.status === "capped" && (
        <Marker role="status" className="text-amber-700 dark:text-amber-400">
          <MarkerIcon>
            <AlertTriangle />
          </MarkerIcon>
          <MarkerContent>{t("agent.run.capped")}</MarkerContent>
        </Marker>
      )}

      {run.usage && (
        <div className="text-[10px] text-muted-foreground">
          {t("agent.run.tokenUsage", {
            promptTokens: formatNumber(run.usage.promptTokens, locale),
            completionTokens: formatNumber(run.usage.completionTokens, locale),
          })}
          {" · "}
          {formatCredits(run.usage.costCredits, locale)}
        </div>
      )}

      {run.budget && <BudgetMeter budget={run.budget} />}
    </div>
  )
}
