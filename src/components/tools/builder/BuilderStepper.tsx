import { Check } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import type { BuilderStep } from "@/lib/tools/builder-model"
import { cn } from "@/lib/utils"

const STEPS: readonly { id: BuilderStep; title: "extensions.steps.describe" | "extensions.steps.review" | "extensions.steps.add"; hint: "extensions.steps.describeHint" | "extensions.steps.reviewHint" | "extensions.steps.addHint" }[] = [
  { id: "describe", title: "extensions.steps.describe", hint: "extensions.steps.describeHint" },
  { id: "review", title: "extensions.steps.review", hint: "extensions.steps.reviewHint" },
  { id: "add", title: "extensions.steps.add", hint: "extensions.steps.addHint" },
]

/** Describe → Review & try → Add to project. Explains the flow before it
 *  starts, then marks where the user is. */
export function BuilderStepper({ current }: { current: BuilderStep }) {
  const t = useT()
  const at = STEPS.findIndex((s) => s.id === current)
  return (
    <nav aria-label={t("extensions.steps.label")}>
      <ol className="grid grid-cols-3 gap-1.5 sm:gap-2" data-testid="builder-steps">
        {STEPS.map((step, i) => {
          const state = i < at ? "done" : i === at ? "current" : "next"
          return (
            <li
              key={step.id}
              aria-current={state === "current" ? "step" : undefined}
              data-state={state}
              className={cn(
                "flex items-start gap-2 rounded-xl border px-2.5 py-2.5 transition-colors duration-200 sm:gap-3 sm:px-3.5 sm:py-3",
                state === "current" ? "border-primary/40 bg-primary/5" : "bg-card",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums",
                  state === "done" && "bg-primary text-primary-foreground",
                  state === "current" && "bg-primary text-primary-foreground",
                  state === "next" && "border text-muted-foreground",
                )}
                aria-hidden
              >
                {state === "done" ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium", state === "next" && "text-muted-foreground")}>{t(step.title)}</span>
                <span className="hidden text-xs leading-snug text-muted-foreground sm:block">{t(step.hint)}</span>
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
