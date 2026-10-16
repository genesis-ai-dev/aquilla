/**
 * TeamStepEvidence.tsx — the "dig deeper" half of the step inspector.
 *
 * Two sources, both scoped to the step's span:
 *  - Outputs: what the span produced, joined from the run's activity bundle
 *    the thread already holds (scene brief construal, staged draft text).
 *    Costs nothing extra to fetch.
 *  - Model calls: the prompt and reply of every model call the span made,
 *    fetched on demand when the section is opened. Traces are kept 30 days
 *    server-side, so an older run shows an explanatory empty state.
 */

import { ChevronRight } from "lucide-react"
import { useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { fetchContextualRunTraces, type ContextualRunTrace } from "@/lib/contextual/transport"
import type { StepEvidence } from "@/lib/agent/step-evidence"

function Disclosure({
  title,
  onOpen,
  children,
}: {
  title: ReactNode
  onOpen?: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => {
          if (!open) onOpen?.()
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md px-1 py-1 text-start text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0", open && "rotate-90")} />
        {title}
      </button>
      {open && <div className="ps-4 pt-0.5">{children}</div>}
    </div>
  )
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] text-muted-foreground">{label}</span>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed select-text">
        {text}
      </pre>
    </div>
  )
}

export function StepOutputs({ evidence }: { evidence: StepEvidence }) {
  const { t } = useI18n()
  const { sceneBrief, drafts } = evidence
  if (!sceneBrief?.construal && drafts.length === 0) return null
  return (
    <Disclosure title={t("agent.team.inspector.outputs")}>
      <div className="flex flex-col gap-2">
        {sceneBrief?.construal && (
          <Block label={t("agent.team.inspector.construal")} text={sceneBrief.construal} />
        )}
        {drafts.map((d, i) => (
          <Block
            key={d.id ?? i}
            label={[d.cellLabel ?? d.cellId, d.status].filter(Boolean).join(" · ")}
            text={d.text ?? ""}
          />
        ))}
      </div>
    </Disclosure>
  )
}

type TraceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; traces: ContextualRunTrace[]; truncated: boolean }

export function StepModelCalls({
  projectId,
  runId,
  spanId,
}: {
  projectId: string
  runId: string
  spanId: string
}) {
  const { t } = useI18n()
  const [state, setState] = useState<TraceState>({ status: "idle" })
  function load(): void {
    if (state.status === "loading" || state.status === "ready") return
    setState({ status: "loading" })
    fetchContextualRunTraces(projectId, runId, spanId).then(
      (result) => {
        setState({ status: "ready", ...result })
      },
      () => {
        setState({ status: "error" })
      },
    )
  }

  return (
    <Disclosure title={t("agent.team.inspector.modelCalls")} onOpen={load}>
      {state.status !== "ready" && state.status !== "error" ? (
        <p className="text-[11px] text-muted-foreground">{t("agent.team.inspector.tracesLoading")}</p>
      ) : state.status === "error" ? (
        <p className="text-[11px] text-destructive">{t("agent.team.inspector.tracesError")}</p>
      ) : state.traces.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("agent.team.inspector.tracesEmpty")}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {state.traces.map((trace) => (
            <TraceCall key={trace.id} trace={trace} />
          ))}
          {state.truncated && (
            <p className="text-[11px] text-muted-foreground">{t("agent.team.inspector.tracesTruncated")}</p>
          )}
        </div>
      )}
    </Disclosure>
  )
}

function TraceCall({ trace }: { trace: ContextualRunTrace }) {
  const { t } = useI18n()
  const tokens = `${trace.promptTokens}→${trace.completionTokens} tok`
  const latency = `${(trace.latencyMs / 1000).toFixed(1)}s`
  return (
    <Disclosure
      title={
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono">
          <span className={cn(trace.error ? "text-destructive" : "text-foreground")}>
            {trace.label || trace.tier}
          </span>
          <span className="truncate">{trace.model}</span>
          <span>{tokens}</span>
          <span>{latency}</span>
          {trace.attempts > 1 && <span>×{trace.attempts}</span>}
        </span>
      }
    >
      <div className="flex flex-col gap-2 pb-1">
        {/* i18n-exempt chat-completions role names, not copy */}
        {trace.error && <Block label={"error"} text={trace.error} />}
        {/* i18n-exempt chat-completions role names, not copy */}
        <Block label={"system"} text={trace.system} />
        {/* i18n-exempt chat-completions role names, not copy */}
        <Block label={"user"} text={trace.user} />
        {/* i18n-exempt chat-completions role names, not copy */}
        {trace.output !== null && <Block label={"output"} text={trace.output} />}
        {trace.truncated && (
          <p className="text-[10px] text-muted-foreground">{t("agent.team.inspector.traceClipped")}</p>
        )}
        {trace.generationId && (
          <p className="break-all font-mono text-[10px] text-muted-foreground">{trace.generationId}</p>
        )}
      </div>
    </Disclosure>
  )
}
