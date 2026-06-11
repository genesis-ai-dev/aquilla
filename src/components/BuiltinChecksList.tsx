import { useMemo } from "react"
import { Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  TranslationRule,
  RuleInfraction,
  AlgorithmicCheckOverride,
  BuiltinCheckId,
} from "@/lib/parsers/types"
import { BUILTIN_CHECKS } from "@/lib/lqa/builtin-registry"

const SEVERITY_OPTIONS: { value: "major" | "minor"; label: string }[] = [
  { value: "major", label: "Major" },
  { value: "minor", label: "Minor" },
]

interface Props {
  builtinRules: TranslationRule[]
  infractions: Map<string, RuleInfraction[]>
  onSetOverride: (id: BuiltinCheckId, override: AlgorithmicCheckOverride) => void
  onHarmonize?: (rule: TranslationRule, violationCount: number) => void
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
    <div className="rounded-md border">
      <div className="border-b bg-muted/30 px-4 py-2 text-sm font-medium">
        Built-in checks
      </div>
      <ul className="divide-y">
        {builtinRules.map((rule) => {
          if (rule.check.type !== "builtin") return null
          const checkId = rule.check.checkId
          const def = BUILTIN_CHECKS[checkId]
          const count = counts.get(rule.id) ?? 0
          const showHarmonize = onHarmonize != null && count > 0
          return (
            <li
              key={rule.id}
              data-testid="builtin-row"
              className="flex items-center gap-3 px-4 py-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{def.name}</div>
                <div className="text-xs text-muted-foreground truncate">{def.description}</div>
              </div>
              {count > 0 && (
                <Badge variant="secondary" className="tabular-nums">
                  {count} violation{count === 1 ? "" : "s"}
                </Badge>
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
                  <Wand2 data-icon="inline-start" />
                  Harmonize all ({count})
                </Button>
              )}
              <Select
                items={SEVERITY_OPTIONS}
                value={rule.severity}
                onValueChange={(v) => onSetOverride(checkId, {
                  enabled: rule.enabled,
                  severity: (v ?? rule.severity) as "major" | "minor",
                })}
              >
                <SelectTrigger size="sm" className="text-xs" aria-label={`${def.name} severity`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SEVERITY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Switch
                size="sm"
                checked={rule.enabled}
                aria-label={`${def.name} enabled`}
                onCheckedChange={(checked) => onSetOverride(checkId, {
                  enabled: checked,
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
