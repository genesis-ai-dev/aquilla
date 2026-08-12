import { useMemo } from "react"
import { Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
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
import { translateRuleName, translateRuleDescription } from "@/lib/lqa/builtin-resolver"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  builtinRules: TranslationRule[]
  infractions: Map<string, RuleInfraction[]>
  onSetOverride: (id: BuiltinCheckId, override: AlgorithmicCheckOverride) => void
  onHarmonize?: (rule: TranslationRule, violationCount: number) => void
  canHarmonize?: boolean
  /**
   * AQU-480: overriding a built-in check's severity/enabled state persists to
   * project_settings (MAINTAINER-gated). Below that floor the write silently
   * 403s, so disable the controls. Defaults true so non-gated callers are
   * unaffected.
   */
  canManage?: boolean
}

export function BuiltinChecksList({ builtinRules, infractions, onSetOverride, onHarmonize, canHarmonize = true, canManage = true }: Props) {
  const t = useT()
  const SEVERITY_OPTIONS: { value: "major" | "minor"; label: string }[] = [
    { value: "major", label: t("rules.severity.major") },
    { value: "minor", label: t("rules.severity.minor") },
  ]
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
        {t("rules.builtinChecks.heading")}
      </div>
      <ul className="divide-y">
        {builtinRules.map((rule) => {
          if (rule.check.type !== "builtin") return null
          const checkId = rule.check.checkId
          const name = translateRuleName(rule, t)
          const description = translateRuleDescription(rule, t)
          const count = counts.get(rule.id) ?? 0
          const showHarmonize = onHarmonize != null && count > 0
          return (
            <li
              key={rule.id}
              data-testid="builtin-row"
              className="flex items-center gap-3 px-4 py-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{name}</div>
                <div className="text-xs text-muted-foreground truncate">{description}</div>
              </div>
              {count > 0 && (
                <Badge variant="secondary" className="tabular-nums">
                  {t("rules.builtinChecks.violationCount", { count })}
                </Badge>
              )}
              {showHarmonize && (
                <AppTooltip
                  content={
                    !canHarmonize
                      ? t("editor.selection.harmonizeNeedLead")
                      : t("rules.builtinChecks.harmonizeAllTooltip", { count })
                  }
                >
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canHarmonize}
                    onClick={() => onHarmonize(rule, count)}
                    data-testid="harmonize-all-btn"
                  >
                    <Wand2 data-icon="inline-start" />
                    {t("rules.builtinChecks.harmonizeAllButton", { count })}
                  </Button>
                </AppTooltip>
              )}
              <Select
                items={SEVERITY_OPTIONS}
                value={rule.severity}
                disabled={!canManage}
                onValueChange={(v) => onSetOverride(checkId, {
                  enabled: rule.enabled,
                  severity: (v ?? rule.severity) as "major" | "minor",
                })}
              >
                <AppTooltip
                  content={!canManage ? t("rules.builtinChecks.manageNeedsMaintainer") : undefined}
                  disabled={canManage}
                >
                  <SelectTrigger
                    size="sm"
                    className="text-xs"
                    aria-label={t("rules.builtinChecks.severitySelectAriaLabel", { name })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                </AppTooltip>
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
                disabled={!canManage}
                aria-label={t("rules.builtinChecks.enabledSwitchAriaLabel", { name })}
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
