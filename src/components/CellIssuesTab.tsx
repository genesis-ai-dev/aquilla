import { AlertCircle, AlertTriangle, ArrowRight, Check } from "lucide-react"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { translateRuleName } from "@/lib/lqa/builtin-resolver"
import { formatInfractionReason } from "@/lib/rules/format-infraction"
import { distinctFindings, waiverKey } from "@/lib/rules/waivers"
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
  onWaive: (input: { ruleId: string; matchHash?: string; reason?: string }) => void
  onUnwaive: (ruleId: string, matchHash?: string) => void
}

/**
 * The expanded row's "Issues" tab: every rule finding on the cell, active ones
 * first and waived ones under their own divider.
 *
 * AQU-1133: waive *and* un-waive are both reachable here. Previously the row
 * was one big button that only opened the violation toast, so the un-waive
 * action lived exclusively in that toast — a waived item in the cell detail was
 * a dead end. Each row now carries its own action button beside the
 * open-the-rule affordance.
 *
 * AQU-1740: one rule can match several times in a cell, and those matches are
 * separate judgements — a reviewer who accepts "Amen amen" has said nothing
 * about a repeated word further down the verse. Each distinct match therefore
 * gets its own row and its own waive, quoting the matched text so it is obvious
 * which one is being accepted. A rule with no concrete match (an absence check)
 * still gets one rule-level row, which waives it across the cell.
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
      {activeInfractions.flatMap((inf) => {
        const rule = ruleMap.get(inf.ruleId)
        const isMajor = rule?.severity === "major"
        const Icon = isMajor ? AlertTriangle : AlertCircle
        const findings = distinctFindings(inf)
        // `undefined` = no finding to name, so the row's waive is cell-wide.
        const targets: (string | undefined)[] =
          findings.length > 0 ? findings.map((f) => f.matchHash) : [undefined]
        return targets.map((matchHash, i) => (
          <div
            key={waiverKey(inf.ruleId, matchHash)}
            data-issue-row={inf.ruleId}
            data-issue-match={matchHash}
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
                {/* Raw cell content: interpolated, never routed through t(). */}
                {matchHash !== undefined && (
                  <span className="ms-1 font-mono text-muted-foreground/80">
                    “{findings[i].matchedText}”
                  </span>
                )}
              </span>
              <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50" />
            </button>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 shrink-0 px-1.5 text-xs"
              disabled={!editable}
              onClick={() => onWaive({ ruleId: inf.ruleId, ...(matchHash ? { matchHash } : {}) })}
            >
              {t("rules.violationPopover.waive")}
            </Button>
          </div>
        ))
      })}
      {waivedInfractions.length > 0 && (
        <>
          <div className="mt-2 px-1 text-xs text-muted-foreground">
            {t("editor.issues.waived")}
          </div>
          {waivedInfractions.flatMap((inf) => {
            const rule = ruleMap.get(inf.ruleId)
            const findings = distinctFindings(inf)
            // A cell-wide waiver carries no hash, so it lists as one row even
            // when the rule matched in several places.
            const targets: (string | undefined)[] =
              findings.length > 0 ? findings.map((f) => f.matchHash) : [undefined]
            return targets.map((matchHash, i) => (
              <div
                key={`waived-${waiverKey(inf.ruleId, matchHash)}`}
                data-issue-row={inf.ruleId}
                data-issue-match={matchHash}
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
                  {matchHash !== undefined && (
                    <span className="ms-1 font-mono">“{findings[i].matchedText}”</span>
                  )}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 shrink-0 px-1.5 text-xs"
                  disabled={!editable}
                  onClick={() => onUnwaive(inf.ruleId, matchHash)}
                >
                  {t("rules.violationPopover.unwaive")}
                </Button>
              </div>
            ))
          })}
        </>
      )}
    </div>
  )
}
