import { Check } from "lucide-react"
import { Fragment } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import type { BuilderStep } from "@/lib/tools/builder-model"
import { cn } from "@/lib/utils"

const STEPS = [
  { id: "describe", title: "extensions.steps.describe" },
  { id: "review", title: "extensions.steps.review" },
  { id: "add", title: "extensions.steps.add" },
] as const satisfies readonly { id: BuilderStep; title: string }[]

/** Describe → Try it → Add it, as a slim, quiet stepper. */
export function BuilderStepper({ current }: { current: BuilderStep }) {
  const t = useT()
  const at = STEPS.findIndex((s) => s.id === current)
  return (
    <nav aria-label={t("extensions.steps.label")}>
      <ol className="flex items-center gap-2 text-xs" data-testid="builder-steps">
        {STEPS.map((step, i) => {
          const state = i < at ? "done" : i === at ? "current" : "next"
          return (
            <Fragment key={step.id}>
              {i > 0 && <li aria-hidden className={cn("h-px w-4 transition-colors duration-200", i <= at ? "bg-primary/50" : "bg-border")} />}
              <li aria-current={state === "current" ? "step" : undefined} data-state={state} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "grid size-4.5 place-items-center rounded-full text-[10px] font-semibold tabular-nums transition-colors duration-200",
                    state === "current" && "bg-primary text-primary-foreground",
                    state === "done" && "bg-primary/15 text-primary",
                    state === "next" && "border text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {state === "done" ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn("font-medium", state === "current" ? "text-foreground" : "text-muted-foreground max-sm:sr-only")}>{t(step.title)}</span>
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
