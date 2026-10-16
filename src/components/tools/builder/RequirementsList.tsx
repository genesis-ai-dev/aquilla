import { useState } from "react"
import { Check, ChevronRight, Circle, CircleDashed, X } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { RequirementStatus, ToolRequirement } from "../../../../shared/tools/requirements"

const ICON = {
  covered: { icon: Check, cls: "text-emerald-600 dark:text-emerald-400", label: "extensions.reqs.covered" },
  partial: { icon: CircleDashed, cls: "text-amber-600 dark:text-amber-400", label: "extensions.reqs.partial" },
  missing: { icon: Circle, cls: "text-amber-600 dark:text-amber-400", label: "extensions.reqs.missing" },
  not_possible: { icon: X, cls: "text-muted-foreground", label: "extensions.reqs.notPossible" },
  planned: { icon: Circle, cls: "text-muted-foreground/60", label: "extensions.reqs.planned" },
} as const satisfies Record<RequirementStatus, { icon: unknown; cls: string; label: string }>

/** What you asked for, as the builder understood it: ✓ covered, ✗ not possible + why. Opens by itself
 *  when something could not be built, so nothing is silently dropped. */
export function RequirementsList({ requirements }: { requirements: ToolRequirement[] }) {
  const t = useT()
  const notCovered = requirements.filter((r) => r.status !== "covered" && r.status !== "planned")
  const [open, setOpen] = useState(notCovered.length > 0)
  if (requirements.length === 0) return null
  const covered = requirements.filter((r) => r.status === "covered").length
  const impossible = requirements.filter((r) => r.status === "not_possible").length
  const unmet = notCovered.length - impossible
  return (
    <section className="rounded-xl border bg-card dark:bg-transparent" data-testid="requirements">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-start text-sm"
      >
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
        <span className="font-medium">{t("extensions.reqs.title")}</span>
        <span className="text-muted-foreground tabular-nums">{t("extensions.reqs.summary", { covered, total: requirements.length })}</span>
        <span className="ms-auto flex items-center gap-1.5">
          {unmet > 0 && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 tabular-nums dark:text-amber-400">
              {t("extensions.reqs.notCoveredCount", { count: unmet })}
            </span>
          )}
          {impossible > 0 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums dark:bg-input/40">
              {t("extensions.reqs.notPossibleCount", { count: impossible })}
            </span>
          )}
        </span>
      </button>
      {open && (
        <ol className="divide-y border-t">
          {requirements.map((r) => {
            const s = ICON[r.status]
            const Icon = s.icon
            return (
              <li key={r.id} className="flex items-start gap-2.5 px-3.5 py-2 text-sm" data-status={r.status} data-testid="requirement">
                <Icon className={cn("mt-0.5 size-3.5 shrink-0", s.cls)} aria-label={t(s.label)} />
                <span className="min-w-0 flex-1">
                  <span className={cn(r.status === "not_possible" && "text-muted-foreground")}>{r.text}</span>
                  {r.priority === "should" && <span className="ms-1.5 text-[11px] text-muted-foreground">{t("extensions.reqs.should")}</span>}
                  {r.note && r.status !== "covered" && <span className="block text-xs text-muted-foreground">{r.note}</span>}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
