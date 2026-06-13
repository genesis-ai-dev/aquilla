/**
 * AgentRunView.tsx — timeline for one translation-agent run.
 *
 * Renders the user's prompt, collapsible step rows (code_start/code_result
 * pairs as a monospace summary), the streamed assistant text (ChatMarkdown,
 * same renderer as chat replies), the usage/cost line, and error/capped
 * states. Proposal cards render separately (AgentDockView) so Apply wiring
 * stays out of this purely presentational component.
 */

import { useState } from "react"
import { AlertTriangle, Book, Check, ChevronRight, Database, FileText, Loader2, Send, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { ChatMarkdown } from "@/components/chat/ChatMarkdown"
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
    <div className="space-y-2">
      {/* User prompt bubble — mirrors chat's user-message alignment. */}
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary px-2.5 py-1.5 text-xs text-primary-foreground">
          {run.prompt}
        </div>
      </div>

      {run.steps.length > 0 && (
        <div className="space-y-1">
          {run.steps.map((s) => (
            <StepRow key={s.step} step={s} />
          ))}
        </div>
      )}

      {run.assistantText && (
        <div className="rounded-lg bg-muted px-2.5 py-1.5 text-xs">
          <ChatMarkdown content={run.assistantText} />
        </div>
      )}

      {run.status === "running" && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Agent working…</span>
        </div>
      )}

      {run.status === "error" && (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{run.errorMessage || "Agent run failed."}</span>
        </div>
      )}

      {run.status === "capped" && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>Run hit its step/token cap — results may be partial.</span>
        </div>
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
