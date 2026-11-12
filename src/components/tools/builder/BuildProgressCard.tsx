import { useEffect, useState } from "react"
import { Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { BuildPhase } from "@/lib/tools/build-flow"
import { formatElapsed, progressSteps } from "@/lib/tools/builder-model"
import { cn } from "@/lib/utils"

const STEP_LABEL = {
  write: "extensions.progress.step.write",
  check: "extensions.progress.step.check",
  try: "extensions.progress.step.try",
  fix: "extensions.progress.step.fix",
} as const

/** Building: the prompt stays where it was (now read-only), with one calm
 *  live status line — current phase, a spinner, elapsed time — and an honest
 *  heads-up that big extensions take minutes and the user can leave. */
export function BuildProgressCard({
  request,
  phase,
  startedAt,
  onCancel,
  compact = false,
}: {
  request: string
  phase: BuildPhase | null
  startedAt: number | null
  onCancel: () => void
  /** Inside the review ("Change it…"): no quote, no heads-up. */
  compact?: boolean
}) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const steps = progressSteps(phase)
  const active = steps.find((s) => s.state === "active") ?? steps[steps.length - 1]
  const label = t(STEP_LABEL[active.id])
  return (
    <section
      className={cn(
        "w-full rounded-2xl border bg-card transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0",
        compact ? "p-4" : "p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-16px_rgb(0_0_0/0.18)] dark:shadow-none",
      )}
      aria-busy="true"
      data-testid="tool-build-progress"
    >
      {!compact && <p className="line-clamp-3 text-[15px] leading-6 text-foreground/70">{request}</p>}
      <div className={cn("flex items-center gap-3", !compact && "mt-5")}>
        <span className="relative grid size-5 place-items-center" aria-hidden>
          <span className="absolute inset-0 rounded-full border-2 border-primary/20" />
          <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary [animation-duration:800ms] motion-reduce:animate-none" />
        </span>
        <span key={active.id} className="text-sm font-medium transition-opacity duration-200 starting:opacity-0">{label}</span>
        <span className="ms-auto font-mono text-xs text-muted-foreground tabular-nums">{startedAt ? formatElapsed(now - startedAt) : "0:00"}</span>
        <Button variant="ghost" size="sm" onClick={onCancel} className="-me-1.5 text-muted-foreground">
          {t("extensions.progress.cancel")}
        </Button>
      </div>
      <ol className="mt-3 flex gap-1" aria-hidden>
        {steps.map((s) => (
          <li
            key={s.id}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-300",
              s.state === "done" ? "bg-primary" : s.state === "active" ? "animate-pulse bg-primary/45 motion-reduce:animate-none" : "bg-muted",
            )}
          />
        ))}
      </ol>
      {!compact && (
        <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("extensions.progress.headsUp")}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">{label}</p>
    </section>
  )
}
