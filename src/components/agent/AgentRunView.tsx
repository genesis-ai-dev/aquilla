/**
 * AgentRunView.tsx — timeline for one translation-agent run.
 *
 * Renders the user's prompt and the streamed assistant reply as shadcn
 * Message/Bubble turns (same components the chat surface uses), collapsible
 * step rows (code_start/code_result pairs as a monospace summary), the
 * usage/cost line, and running/error/capped states as Marker rows. Proposal
 * cards render separately (AgentDockView) so Apply wiring stays out of this
 * purely presentational component.
 */

import { useState } from "react"
import { AlertTriangle, Book, Check, ChevronRight, Database, FileText, Loader2, Send, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { ChatMarkdown } from "@/components/chat/ChatMarkdown"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent } from "@/components/ui/message"
import { Spinner } from "@/components/ui/spinner"
import type { AgentRunUi, AgentStepUi } from "@/lib/agent/run-state"

const STEP_ICON = {
  sql: Database,
  emit: Send,
  docs: FileText,
  aquifer: Book,
} as const

const STEP_LABEL = {
  sql: "sql",
  emit: "emit",
  docs: "docs",
  aquifer: "Bible reference",
} as const

function StepRow({ step }: { step: AgentStepUi }) {
  const [open, setOpen] = useState(false)
  const Icon = STEP_ICON[step.kind]
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
        <span className="font-mono text-muted-foreground">{STEP_LABEL[step.kind]}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{step.summary}</span>
        {step.ok === undefined ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" aria-label="Step running" />
        ) : step.ok ? (
          <Check className="h-3 w-3 shrink-0 text-emerald-600" aria-label="Step succeeded" />
        ) : (
          <X className="h-3 w-3 shrink-0 text-destructive" aria-label="Step failed" />
        )}
      </button>
      {open && step.resultSummary !== undefined && (
        <pre className="overflow-x-auto border-t px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {step.resultSummary}
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
}

export function AgentRunView({ run }: AgentRunViewProps) {
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

      {run.steps.length > 0 && (
        <div className="flex flex-col gap-1">
          {run.steps.map((s) => (
            <StepRow key={s.step} step={s} />
          ))}
        </div>
      )}

      {/* Assistant reply — ghost bubble keeps long-form markdown aligned with
          the column at full width instead of a cramped framed bubble. */}
      {run.assistantText && (
        <Message align="start">
          <MessageContent>
            <Bubble variant="ghost">
              <BubbleContent>
                <ChatMarkdown content={run.assistantText} />
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )}

      {run.status === "running" && (
        <Marker role="status">
          <MarkerIcon>
            <Spinner />
          </MarkerIcon>
          <MarkerContent>Agent working…</MarkerContent>
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
