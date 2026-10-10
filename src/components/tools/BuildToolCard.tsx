/**
 * The one prompt box: describe a tool, press Build. The builder loop (model →
 * lint → sandboxed smoke render → repair ≤2×) shows as a single calm card —
 * one step label and a quiet progress bar — and a failure as one short line
 * with "Try again" (the builder's own message sits behind "Details").
 */

import { useState } from "react"
import { ArrowUp, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import { runBuildFlow, type BuildFlowResult, type BuildPhase } from "@/lib/tools/build-flow"
import { runToolSmoke } from "@/lib/tools/smoke"
import { buildToolAttempt } from "@/lib/tools/tools-api"

export interface BuiltTool {
  request: string
  result: BuildFlowResult
}

/** Rough share of the loop each phase stands for (it is one model call plus
 *  quick gates, so "writing" dominates). */
function progressOf(phase: BuildPhase | null): number {
  if (!phase) return 4
  switch (phase.kind) {
    case "generating":
      return phase.attempt === 0 ? 30 : 70
    case "linting":
      return phase.attempt === 0 ? 72 : 88
    case "smoke":
      return phase.attempt === 0 ? 82 : 94
    case "repairing":
      return 60
    case "done":
    case "failed":
      return 100
  }
}

export function BuildToolCard({
  projectId,
  jwt,
  onBuilt,
}: {
  projectId: string
  jwt: string
  onBuilt: (built: BuiltTool) => void
}) {
  const t = useT()
  const [request, setRequest] = useState("")
  const [phase, setPhase] = useState<BuildPhase | null>(null)
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)

  const build = async () => {
    const text = request.trim()
    if (!text || running) return
    setRunning(true)
    setPhase(null)
    setFailure(null)
    setShowDetails(false)
    try {
      const result = await runBuildFlow(text, {
        attempt: (body) => buildToolAttempt(jwt, projectId, body),
        smoke: (source, manifest) => runToolSmoke(source, manifest),
        onPhase: setPhase,
      })
      if (result.ok) {
        onBuilt({ request: text, result })
        setRequest("")
        setPhase(null)
      } else setFailure(result.failures[result.failures.length - 1] ?? "")
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const step = (p: BuildPhase | null): string => {
    switch (p?.kind) {
      case undefined:
      case "generating":
        return t("extensions.build.phaseGenerating", { attempt: (p?.attempt ?? 0) + 1 })
      case "linting":
        return t("extensions.build.phaseLinting")
      case "smoke":
        return t("extensions.build.phaseSmoke")
      case "repairing":
        return t("extensions.build.phaseRepairing", { attempt: p.attempt + 1 })
      case "done":
        return t("extensions.build.phaseDone", { attempts: p.attempts })
      case "failed":
        return t("extensions.build.failed")
    }
  }

  return (
    <section aria-label={t("extensions.build.heading")} className="flex flex-col gap-2">
      <div
        className={cn(
          "relative rounded-xl border bg-card shadow-xs transition-[box-shadow,border-color]",
          "focus-within:border-ring/60 focus-within:ring-3 focus-within:ring-ring/15",
        )}
      >
        <textarea
          aria-label={t("extensions.build.heading")}
          placeholder={t("extensions.build.placeholder")}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void build()
            }
          }}
          rows={3}
          disabled={running}
          className="block w-full resize-none rounded-xl bg-transparent px-4 pt-3.5 pb-12 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
        />
        <div className="absolute end-2.5 bottom-2.5 flex items-center gap-2">
          <kbd className="hidden rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">⌘↵</kbd>
          <Button size="sm" onClick={() => void build()} disabled={running || request.trim().length === 0} className="gap-1.5 rounded-lg">
            {running ? <Spinner className="size-3.5" /> : <ArrowUp className="size-3.5" aria-hidden />}
            {t("extensions.build.submit")}
          </Button>
        </div>
      </div>

      {running && (
        <div className="rounded-xl border bg-card px-4 py-3" aria-live="polite" data-testid="tool-build-progress">
          <div className="flex items-center gap-2 text-sm">
            <Spinner className="size-3.5 text-muted-foreground" />
            <span>{step(phase)}</span>
          </div>
          <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressOf(phase)}>
            <div className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out" style={{ width: `${progressOf(phase)}%` }} />
          </div>
        </div>
      )}

      {failure !== null && !running && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 text-destructive">{t("extensions.build.failed")}</span>
            {failure && (
              <Button size="xs" variant="ghost" onClick={() => setShowDetails((v) => !v)} aria-expanded={showDetails} className="text-muted-foreground">
                <ChevronRight className={cn("size-3 transition-transform", showDetails && "rotate-90")} aria-hidden />
                {t("extensions.build.details")}
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={() => void build()}>
              {t("extensions.build.tryAgain")}
            </Button>
          </div>
          {showDetails && failure && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted p-2 text-xs whitespace-pre-wrap text-muted-foreground">{failure}</pre>
          )}
        </div>
      )}
    </section>
  )
}
