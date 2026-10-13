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
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useT } from "@/lib/i18n/I18nProvider"
import { BIBLE_CHECK_NEEDS, isBibleCheckId, type BibleCheckSlot } from "../../db/shared/bible-checks/types"
import {
  filledLanguageProfileSlots,
  readLanguageProfile,
  type LanguageProfile,
} from "../../db/shared/language-profile"

/** AQU-1688: why a Bible data check is dormant, by the Language-profile slot it waits for. */
const NEEDS_KEY: Readonly<Record<BibleCheckSlot, MessageKey>> = {
  quoteMarks: "bibleData.check.needs.quoteMarks",
  questionMarkers: "bibleData.check.needs.questionMarkers",
}

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
  /**
   * AQU-1688: the project's Language profile. A Bible data check whose slot
   * is empty is dormant, and its row says which slot it needs.
   */
  languageProfile?: LanguageProfile | null
}

const isBibleRule = (rule: TranslationRule) => rule.check.type === "builtin" && isBibleCheckId(rule.check.checkId)

export function BuiltinChecksList({
  builtinRules,
  infractions,
  onSetOverride,
  onHarmonize,
  canHarmonize = true,
  canManage = true,
  languageProfile,
}: Props) {
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
  const filledSlots = filledLanguageProfileSlots(readLanguageProfile(languageProfile))
  const textRules = builtinRules.filter((rule) => !isBibleRule(rule))
  const bibleRules = builtinRules.filter(isBibleRule)

  const renderRow = (rule: TranslationRule) => {
    if (rule.check.type !== "builtin") return null
    const checkId = rule.check.checkId
    const name = translateRuleName(rule, t)
    const description = translateRuleDescription(rule, t)
    const count = counts.get(rule.id) ?? 0
    const showHarmonize = onHarmonize != null && count > 0
    const needs = isBibleCheckId(checkId) ? BIBLE_CHECK_NEEDS[checkId].filter((slot) => !filledSlots.has(slot)) : []
    return (
      <li
        key={rule.id}
        data-testid="builtin-row"
        className="flex items-center gap-3 px-4 py-3 text-sm"
      >
        <div className="min-w-0 flex-1">
          <div className="font-medium">{name}</div>
          <div className="text-xs text-muted-foreground truncate">{description}</div>
          {needs.map((slot) => (
            <div key={slot} data-testid="builtin-row-needs" className="text-xs text-amber-700 dark:text-amber-400">
              {t(NEEDS_KEY[slot])}
            </div>
          ))}
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
  }

  return (
    <>
      <div className="rounded-md border">
        <div className="border-b bg-muted/30 px-4 py-2 text-sm font-medium">
          {t("rules.builtinChecks.heading")}
        </div>
        <ul className="divide-y">{textRules.map(renderRow)}</ul>
      </div>
      {/* AQU-1688: present only while the project's Bible data checks enrichment is on. */}
      {bibleRules.length > 0 && (
        <div className="mt-4 rounded-md border" data-testid="builtin-bible-checks">
          <div className="border-b bg-muted/30 px-4 py-2 text-sm font-medium">
            {t("bibleData.enrichment.checks.label")}
          </div>
          <ul className="divide-y">{bibleRules.map(renderRow)}</ul>
        </div>
      )}
    </>
  )
}
