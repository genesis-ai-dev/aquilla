/**
 * "Build me a tool that…" — runs the builder loop (model → lint → sandboxed
 * smoke render → repair ≤2×) with a progress card, then hands the vetted
 * candidate to the install dialog.
 */

import { useState } from "react"
import { CheckCircle2, Hammer, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useT } from "@/lib/i18n/I18nProvider"
import { runBuildFlow, type BuildFlowResult, type BuildPhase } from "@/lib/tools/build-flow"
import { runToolSmoke } from "@/lib/tools/smoke"
import { buildToolAttempt } from "@/lib/tools/tools-api"

export interface BuiltTool {
  request: string
  result: BuildFlowResult
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
  const [phases, setPhases] = useState<BuildPhase[]>([])
  const [running, setRunning] = useState(false)
  const [last, setLast] = useState<BuildFlowResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const build = async () => {
    const text = request.trim()
    if (!text) return
    setRunning(true)
    setPhases([])
    setLast(null)
    setError(null)
    try {
      const result = await runBuildFlow(text, {
        attempt: (body) => buildToolAttempt(jwt, projectId, body),
        smoke: (source, manifest) => runToolSmoke(source, manifest),
        onPhase: (phase) => setPhases((prev) => [...prev, phase]),
      })
      setLast(result)
      if (result.ok) onBuilt({ request: text, result })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const phaseText = (p: BuildPhase): string => {
    switch (p.kind) {
      case "generating":
        return t("extensions.build.phaseGenerating", { attempt: p.attempt + 1 })
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
    <section aria-label={t("extensions.build.heading")} className="rounded-lg border bg-card p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Hammer className="size-4" aria-hidden />
        {t("extensions.build.heading")}
      </h2>
      <Textarea
        aria-label={t("extensions.build.heading")}
        placeholder={t("extensions.build.placeholder")}
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        rows={3}
        disabled={running}
      />
      <div className="mt-2 flex items-center gap-3">
        <Button onClick={() => void build()} disabled={running || request.trim().length === 0}>
          {running && <Spinner className="size-3.5" />}
          {t("extensions.build.submit")}
        </Button>
        {last && <span className="text-xs text-muted-foreground">{t("extensions.build.cost", { cost: last.cost.toFixed(2) })}</span>}
      </div>
      {phases.length > 0 && (
        <ol className="mt-3 space-y-1 text-sm" aria-live="polite" data-testid="tool-build-progress">
          {phases.map((p, i) => (
            <li key={i} className="flex items-start gap-2">
              {p.kind === "done" ? (
                <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" aria-hidden />
              ) : p.kind === "failed" ? (
                <XCircle className="mt-0.5 size-4 text-destructive" aria-hidden />
              ) : i === phases.length - 1 && running ? (
                <Spinner className="mt-0.5 size-4" />
              ) : (
                <CheckCircle2 className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
              )}
              <span>{phaseText(p)}</span>
            </li>
          ))}
        </ol>
      )}
      {last && !last.ok && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
          {last.failures[last.failures.length - 1]}
        </pre>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
  )
}
