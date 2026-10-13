import { useEffect, useState } from "react"
import { Check, Circle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import type { BuildPhase } from "@/lib/tools/build-flow"
import { formatElapsed, progressSteps, type ProgressStepId } from "@/lib/tools/builder-model"
import { cn } from "@/lib/utils"

const LABEL: Record<ProgressStepId, { title: `extensions.progress.step.${ProgressStepId}`; hint: `extensions.progress.step.${ProgressStepId}Hint` }> = {
  write: { title: "extensions.progress.step.write", hint: "extensions.progress.step.writeHint" },
  check: { title: "extensions.progress.step.check", hint: "extensions.progress.step.checkHint" },
  try: { title: "extensions.progress.step.try", hint: "extensions.progress.step.tryHint" },
  fix: { title: "extensions.progress.step.fix", hint: "extensions.progress.step.fixHint" },
}

function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  return startedAt === null ? 0 : now - startedAt
}

/** While the AI builds: the user's words, the real steps (write → safety
 *  check → try in a sandbox, with "fix" when a check failed), the elapsed
 *  time against the usual, and Cancel. */
export function BuildProgressCard({
  request,
  phase,
  startedAt,
  onCancel,
}: {
  request: string
  phase: BuildPhase | null
  startedAt: number | null
  onCancel: () => void
}) {
  const t = useT()
  const elapsed = useElapsed(startedAt)
  const steps = progressSteps(phase)
  const active = steps.find((s) => s.state === "active")
  return (
    <section
      aria-label={t("extensions.progress.title")}
      className="flex flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0 sm:p-5"
      data-testid="tool-build-progress"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold tracking-tight">{t("extensions.progress.title")}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t("extensions.progress.elapsed", { time: formatElapsed(elapsed) })} · {t("extensions.progress.typical")}
        </span>
        <Button variant="ghost" size="sm" className="ms-auto" onClick={onCancel}>
          {t("extensions.progress.cancel")}
        </Button>
      </div>

      <figure className="rounded-xl border-s-2 border-primary/40 bg-muted/40 px-3.5 py-2.5">
        <figcaption className="text-xs font-medium text-muted-foreground">{t("extensions.progress.youAsked")}</figcaption>
        <blockquote className="mt-0.5 text-sm text-foreground/90">{request}</blockquote>
      </figure>

      <ol className="flex flex-col gap-2.5" aria-live="polite">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-3" data-step={s.id} data-state={s.state}>
            <span
              className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
                s.state === "done" && "bg-primary text-primary-foreground",
                s.state === "active" && "text-primary",
                s.state === "pending" && "text-muted-foreground/50",
              )}
              aria-hidden
            >
              {s.state === "done" ? <Check className="size-3" /> : s.state === "active" ? <Spinner className="size-4" /> : <Circle className="size-3.5" />}
            </span>
            <span className="min-w-0">
              <span className={cn("block text-sm", s.state === "pending" ? "text-muted-foreground" : "font-medium")}>{t(LABEL[s.id].title)}</span>
              {s.state === "active" && <span className="block text-xs text-muted-foreground">{t(LABEL[s.id].hint)}</span>}
            </span>
          </li>
        ))}
      </ol>
      {/* Screen readers hear the step that is running now. */}
      <span className="sr-only" role="status">{active ? t(LABEL[active.id].title) : ""}</span>
    </section>
  )
}
