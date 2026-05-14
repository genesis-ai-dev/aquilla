import { useMemo } from "react"
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
}

export function BuiltinChecksList({ builtinRules, infractions, onSetOverride }: Props) {
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
