import { useMemo } from "react"
import { Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type {
  TranslationRule,
  RuleInfraction,
  AlgorithmicCheckOverride,
  BuiltinCheckId,
} from "@/lib/parsers/types"
import { BUILTIN_CHECKS } from "@/lib/lqa/builtin-registry"

interface Props {
  builtinRules: TranslationRule[]
  infractions: Map<string, RuleInfraction[]>
  onSetOverride: (id: BuiltinCheckId, override: AlgorithmicCheckOverride) => void
  /**
   * FRO-186: called when the user clicks "Harmonize all (N)" on a check row.
   * Receives the rule whose check has violations (has an auto-fix). The parent
   * opens FixReviewPanel in multi-cell scope for the harmonization sweep.
   * Optional — when absent the button is not rendered (preserves back-compat).
   */
  onHarmonize?: (rule: TranslationRule, violationCount: number) => void
  /**
   * FRO-186: whether the current user has the harmonize_min_role.
   * When false, the "Harmonize all" button is disabled. Defaults to true
   * when omitted (fail-open; server is authoritative).
   */
  canHarmonize?: boolean
}

export function BuiltinChecksList({ builtinRules, infractions, onSetOverride, onHarmonize, canHarmonize = true }: Props) {
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const cellInfractions of infractions.values()) {
      for (const inf of cellInfractions) {
        c.set(inf.ruleId, (c.get(inf.ruleId) ?? 0) + 1)
      }
    }
    return c
  }, [infractions])

  return (
    <div className="border rounded-md">
      <div className="px-4 py-2 border-b bg-muted/30 text-sm font-medium">
        Built-in checks
      </div>
      <ul className="divide-y">
        {builtinRules.map((rule) => {
          if (rule.check.type !== "builtin") return null
          const checkId = rule.check.checkId
          const def = BUILTIN_CHECKS[checkId]
          const count = counts.get(rule.id) ?? 0
          // FRO-186: show "Harmonize all (N)" when the check has violations and
          // the parent has supplied the onHarmonize callback.
          const showHarmonize = onHarmonize != null && count > 0
          return (
            <li
              key={rule.id}
              data-testid="builtin-row"
              className="flex items-center gap-3 px-4 py-3 text-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium">{def.name}</div>
                <div className="text-muted-foreground text-xs truncate">{def.description}</div>
              </div>
              {count > 0 && (
                <div className="text-xs text-muted-foreground tabular-nums">
                  {count} violation{count === 1 ? "" : "s"}
                </div>
              )}
              {showHarmonize && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canHarmonize}
                  title={
                    !canHarmonize
                      ? "You need project lead role to run a harmonization sweep"
                      : `Harmonize all ${count} violation${count === 1 ? "" : "s"} for this check`
                  }
                  onClick={() => onHarmonize(rule, count)}
                  data-testid="harmonize-all-btn"
                >
                  <Wand2 className="mr-1 h-3.5 w-3.5" />
                  Harmonize all ({count})
                </Button>
              )}
              <select
                className="h-7 px-2 text-xs border rounded-sm bg-background"
                value={rule.severity}
                aria-label={`${def.name} severity`}
                onChange={(e) => onSetOverride(checkId, {
                  enabled: rule.enabled,
                  severity: e.target.value as "major" | "minor",
                })}
              >
                <option value="major">Major</option>
                <option value="minor">Minor</option>
              </select>
              <input
                type="checkbox"
                checked={rule.enabled}
                aria-label={`${def.name} enabled`}
                onChange={(e) => onSetOverride(checkId, {
                  enabled: e.target.checked,
                  severity: rule.severity,
                })}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
