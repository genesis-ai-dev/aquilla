/**
 * BibleFactsEvidence — the Bible facts each span of a run used (AQU-1690).
 *
 * Autopilot records, per span, the facts lines its construe and draft
 * prompts carried (a "bible-facts" trace row: who speaks to whom, quote
 * levels, who is named). The activity inspector shows them here, loaded when
 * opened. Traces are kept 30 days, so an older run shows none.
 */

import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import { fetchContextualRunTraces, type ContextualRunTrace } from "@/lib/contextual/transport"

type FactsState =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; traces: ContextualRunTrace[]; truncated: boolean }

const BIBLE_FACTS_LABEL = "bible-facts"

export function BibleFactsEvidence({ projectId, runId }: { projectId: string; runId: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<FactsState>({ status: "idle" })

  function toggle(): void {
    const next = !open
    setOpen(next)
    if (!next || state.status === "loading" || state.status === "ready") return
    setState({ status: "loading" })
    fetchContextualRunTraces(projectId, runId, undefined, { label: BIBLE_FACTS_LABEL }).then(
      (result) => setState({ status: "ready", ...result }),
      () => setState({ status: "error" }),
    )
  }

  return (
    <div className="flex flex-col gap-2" data-testid="bible-facts-evidence">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center gap-1 self-start rounded-md px-1 py-1 text-sm font-medium transition-colors hover:bg-accent/40"
      >
        <ChevronRight className={cn("h-4 w-4 shrink-0", open && "rotate-90")} aria-hidden />
        {t("autopilot.inspector.context.bibleFacts")}
      </button>
      {open && (
        <div className="flex flex-col gap-2 ps-5">
          {state.status === "ready" ? (
            state.traces.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("autopilot.inspector.context.bibleFactsNone")}</p>
            ) : (
              <>
                {state.traces.map((trace) => (
                  <pre
                    key={trace.id}
                    className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-xs leading-relaxed text-muted-foreground"
                  >
                    {trace.user}
                  </pre>
                ))}
                {state.truncated && (
                  <p className="text-xs text-muted-foreground">{t("autopilot.inspector.context.bibleFactsTruncated")}</p>
                )}
              </>
            )
          ) : state.status === "error" ? (
            <p className="text-sm text-destructive">{t("autopilot.inspector.context.bibleFactsError")}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("autopilot.inspector.context.bibleFactsLoading")}</p>
          )}
        </div>
      )}
    </div>
  )
}
