// AQU-1656: "Show prompt" on an AI draft in the cell history drawer — the
// exact messages the model saw and its raw reply, loaded on demand from the
// project's AI intervention trail. A draft that is no longer the cell's
// current version says so: the prompt explains that older text, not this one.

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useT } from "@/lib/i18n/I18nProvider"
import { fetchInterventionTrace, type InterventionTrace } from "@/lib/ai-interventions/client"

type TraceState =
  | { status: "idle" | "loading" | "missing" | "error" }
  | { status: "loaded"; trace: InterventionTrace }

export function AiTracePanel({
  projectId,
  interventionId,
  isCurrent,
}: {
  projectId: string
  interventionId: string
  isCurrent: boolean
}) {
  const t = useT()
  const { session } = useFrontierSession()
  const token = session?.jwt
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<TraceState>({ status: "idle" })

  const load = (jwt: string) => {
    setState({ status: "loading" })
    fetchInterventionTrace(projectId, interventionId, jwt)
      .then((trace) => setState(trace ? { status: "loaded", trace } : { status: "missing" }))
      .catch(() => setState({ status: "error" }))
  }

  if (!token) return null
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="mt-1 text-[11px]">
      <button
        type="button"
        onClick={() => {
          const opening = !open
          setOpen(opening)
          if (opening && (state.status === "idle" || state.status === "error")) load(token)
        }}
        className="flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <Chevron className="h-3 w-3" />
        {open ? t("editor.history.aiTrace.hide") : t("editor.history.aiTrace.show")}
      </button>
      {open && (
        <div className="mt-1 space-y-1.5 rounded border bg-muted/30 p-2">
          {!isCurrent && (
            <p className="text-amber-700 dark:text-amber-300">{t("editor.history.aiTrace.olderVersion")}</p>
          )}
          {state.status === "loading" && <Spinner className="h-3 w-3" />}
          {state.status === "missing" && (
            <p className="text-muted-foreground">{t("editor.history.aiTrace.missing")}</p>
          )}
          {state.status === "error" && (
            <p className="text-muted-foreground">{t("editor.history.aiTrace.loadFailed")}</p>
          )}
          {state.status === "loaded" && (
            <>
              {state.trace.messages.map((m, i) => (
                <div key={i}>
                  <div className="font-medium uppercase tracking-wide text-muted-foreground">{m.role}</div>
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px]">{m.content}</pre>
                </div>
              ))}
              <div>
                <div className="font-medium uppercase tracking-wide text-muted-foreground">
                  {t("editor.history.aiTrace.output")}
                </div>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px]">{state.trace.output}</pre>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
