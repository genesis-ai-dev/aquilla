/**
 * Approved style rules, grouped by category (AQU-934 phase 2).
 *
 * Category/scope/severity wording is resolved once by the section shell and
 * handed down as `StyleRuleLabels`, so this list and the candidates queue can
 * never drift apart on the same vocabulary.
 *
 * Enabling a rule and editing where it applies are PROJECT_LEAD+ acts; below
 * the floor the controls stay visible but disabled (the switch carries the
 * rule's state, so hiding it would hide information), and the section header
 * explains the lock once via `RoleLockTooltip`.
 */

import { Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useT } from "@/lib/i18n/I18nProvider"
import type {
  StyleRule,
  StyleRuleCategory,
  StyleRuleScope,
} from "@/lib/rules/style-rule-types"

/** Already-translated style-rule vocabulary, resolved once per render tree. */
export interface StyleRuleLabels {
  /** Library grouping order — broad vocabulary first, catch-all last. */
  categoryOrder: readonly StyleRuleCategory[]
  category: Record<StyleRuleCategory, string>
  scope: Record<StyleRuleScope, string>
  severity: Record<StyleRule["severity"], string>
}

interface StyleRuleLibraryProps {
  rules: StyleRule[]
  canManage: boolean
  labels: StyleRuleLabels
  onToggleEnabled: (rule: StyleRule, enabled: boolean) => void
  onOpenApplicability: (rule: StyleRule) => void
  /** Opens AI refinement of the rule's targets. Absent = the run has no source
   *  of segments (or no model), so the action is not offered at all. */
  onRefine?: (rule: StyleRule) => void
}

export function StyleRuleLibrary({
  rules,
  canManage,
  labels,
  onToggleEnabled,
  onOpenApplicability,
  onRefine,
}: StyleRuleLibraryProps) {
  const t = useT()

  const groups = labels.categoryOrder
    .map((category) => ({
      category,
      rules: rules.filter((rule) => rule.category === category),
    }))
    .filter((group) => group.rules.length > 0)

  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 px-4 py-5">
        <p className="text-xs text-muted-foreground/60 italic">
          {t("terminology.livingMemory.styleRules.library.empty")}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.category} className="flex flex-col gap-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {labels.category[group.category]}
          </h4>
          {group.rules.map((rule) => (
            <Card key={rule.id} className="overflow-hidden">
              <CardContent className="flex items-start gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <p className="text-sm leading-relaxed">{rule.instruction}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">{labels.severity[rule.severity]}</Badge>
                    <Badge variant="secondary">{labels.scope[rule.scope]}</Badge>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={rule.enabled}
                    disabled={!canManage}
                    onCheckedChange={(checked: boolean) => onToggleEnabled(rule, checked)}
                    aria-label={t("rules.surface.enabledLabel")}
                  />
                  <Button
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={!canManage}
                    onClick={() => onOpenApplicability(rule)}
                  >
                    {t("terminology.livingMemory.styleRules.library.applicability")}
                  </Button>
                  {onRefine ? (
                    <Button
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={!canManage}
                      onClick={() => onRefine(rule)}
                    >
                      <Sparkles className="h-3 w-3" aria-hidden="true" />
                      {t("terminology.livingMemory.styleRules.refine.button")}
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ))}
    </div>
  )
}
