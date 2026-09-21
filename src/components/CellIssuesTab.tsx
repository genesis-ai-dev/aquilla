import { AlertCircle, AlertTriangle, ArrowRight, Check } from "lucide-react"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { translateRuleName } from "@/lib/lqa/builtin-resolver"
import { formatInfractionReason } from "@/lib/rules/format-infraction"
import { cn } from "@/lib/utils"

interface CellIssuesTabProps {
  /** Rule infractions still counting against the cell. */
  activeInfractions: RuleInfraction[]
  /** Infractions the team has explicitly waived. */
  waivedInfractions: RuleInfraction[]
  ruleMap: Map<string, TranslationRule>
  /** Mirrors the row's write permission — `cell.waive`/`cell.unwaive` are CONTRIBUTOR+. */
  editable: boolean
  onOpenRule: (ruleId: string) => void
  onWaive: (input: { ruleId: string; reason?: string }) => void
  onUnwaive: (ruleId: string) => void
}

/**
 * The expanded row's "Issues" tab: every rule infraction on the cell, active
 * ones first and waived ones under their own divider.
 *
 * AQU-1133: waive *and* un-waive are both reachable here. Previously the row
 * was one big button that only opened the violation toast, so the un-waive
 * action lived exclusively in that toast — a waived item in the cell detail was
 * a dead end. Each row now carries its own action button beside the
 * open-the-rule affordance.
 */
export function CellIssuesTab({
  activeInfractions,
  waivedInfractions,
  ruleMap,
  editable,
  onOpenRule,
  onWaive,
  onUnwaive,
}: CellIssuesTabProps) {
  const t = useT()

  if (activeInfractions.length === 0 && waivedInfractions.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="py-3 text-center text-xs text-muted-foreground">
          {t("editor.issues.none")}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {activeInfractions.map((inf) => {
        const rule = ruleMap.get(inf.ruleId)
        const isMajor = rule?.severity === "major"
        const Icon = isMajor ? AlertTriangle : AlertCircle
        return (
          <div
            key={inf.ruleId}
            data-issue-row={inf.ruleId}
            className="bg-card flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-xs"
          >
            <Icon
              className={cn(
                "mt-0.5 h-3 w-3 shrink-0",
                isMajor ? "text-red-500" : "text-amber-500",
              )}
            />
            <button
              type="button"
              onClick={() => onOpenRule(inf.ruleId)}
              className="flex flex-1 items-start gap-2 text-start transition-all"
            >
              <span className="flex-1">
                <span className="font-medium text-foreground">
                  {rule ? translateRuleName(rule, t) : inf.ruleId}
                </span>
                <span className="ms-1 text-muted-foreground">
                  — {formatInfractionReason(inf, t)}
                </span>
              </span>
              <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50" />
            </button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 shrink-0 px-1.5 text-xs"
              disabled={!editable}
              onClick={() => onWaive({ ruleId: inf.ruleId })}
            >
              {t("rules.violationPopover.waive")}
            </Button>
          </div>
        )
      })}
      {waivedInfractions.length > 0 && (
        <>
          <div className="mt-2 px-1 text-xs text-muted-foreground">
            {t("editor.issues.waived")}
          </div>
          {waivedInfractions.map((inf) => {
            const rule = ruleMap.get(inf.ruleId)
            return (
              <div
                key={`waived-${inf.ruleId}`}
                data-issue-row={inf.ruleId}
                data-issue-waived="true"
                className="bg-muted flex w-full items-start gap-2 rounded-xl px-2.5 py-1.5 text-xs text-muted-foreground/70"
              >
                <Check className="mt-0.5 h-3 w-3 shrink-0" />
                <button
                  type="button"
                  onClick={() => onOpenRule(inf.ruleId)}
                  className="flex-1 text-start transition-all"
                >
                  {rule ? translateRuleName(rule, t) : inf.ruleId}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 shrink-0 px-1.5 text-xs"
                  disabled={!editable}
                  onClick={() => onUnwaive(inf.ruleId)}
                >
                  {t("rules.violationPopover.unwaive")}
                </Button>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
