/**
 * AQU-2342: the organization-rule and style-rule rows of the unified Checks
 * list. Each opens the editor its store already has — RuleEditor for an org
 * rule, the applicability dialog (and AI refine) for a style rule — so the
 * list changes only where the checks are SHOWN, not how they are kept.
 */
import type { ReactNode } from "react"
import { Pencil, Sparkles, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { AppTooltip } from "@/components/ui/tooltip"
import { RuleEditor } from "@/components/RuleEditor"
import { SeverityBadge, SeverityIcon } from "@/components/rules/RuleSeverity"
import { useT } from "@/lib/i18n/I18nProvider"
import type { CellData } from "@/hooks/useCells"
import type { TranslationRule } from "@/lib/parsers/types"
import type { StyleRule } from "@/lib/rules/style-rule-types"

interface OrgCheckRowProps {
  rule: TranslationRule
  chips: ReactNode
  /** Org MAINTAINER+ (useOrgSettings.canEdit). Below it the row is read-only. */
  canEdit: boolean
  editing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onUpdate: (updates: Partial<TranslationRule>) => Promise<void>
  onDelete: () => void
  cells: CellData[]
}

export function OrgCheckRow({ rule, chips, canEdit, editing, onEdit, onCancelEdit, onUpdate, onDelete, cells }: OrgCheckRowProps) {
  const t = useT()
  return (
    <li data-check-kind="org" className="rounded-md border p-3">
      <div className="flex items-start gap-3">
        <SeverityIcon severity={rule.severity} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{rule.name}</span>
            <SeverityBadge severity={rule.severity} />
            {chips}
          </div>
          {rule.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{rule.description}</p>}
        </div>
        {canEdit ? (
          <div className="flex shrink-0 items-center gap-1">
            <AppTooltip content={t("rules.surface.editOrgRuleTooltip")}>
              <Button variant="ghost" onClick={onEdit} aria-label={t("rules.surface.editOrgRuleTooltip")}>
                <Pencil />
              </Button>
            </AppTooltip>
            <Switch
              size="sm"
              checked={rule.enabled}
              onCheckedChange={(checked) => void onUpdate({ enabled: checked })}
              aria-label={
                rule.enabled
                  ? t("rules.surface.disableOrgRuleAriaLabel", { name: rule.name })
                  : t("rules.surface.enableOrgRuleAriaLabel", { name: rule.name })
              }
            />
            <Button variant="ghost" onClick={onDelete} aria-label={t("common.delete")}>
              <Trash2 />
            </Button>
          </div>
        ) : (
          <Badge variant="outline" className="shrink-0">{t("common.readOnly")}</Badge>
        )}
      </div>
      {editing && canEdit && (
        <>
          <Separator className="my-3" />
          <RuleEditor
            initialRule={rule}
            cells={cells}
            onSave={async (updates) => {
              await onUpdate(updates)
              onCancelEdit()
            }}
            onCancel={onCancelEdit}
          />
        </>
      )}
    </li>
  )
}

interface StyleCheckRowProps {
  rule: StyleRule
  chips: ReactNode
  /** The rule's category, already translated. */
  categoryLabel: string
  /** PROJECT_LEAD+: toggle and edit where it applies. */
  canManage: boolean
  onToggle: (enabled: boolean) => void
  onOpenApplicability: () => void
  onRefine?: () => void
}

export function StyleCheckRow({ rule, chips, categoryLabel, canManage, onToggle, onOpenApplicability, onRefine }: StyleCheckRowProps) {
  const t = useT()
  return (
    <li data-check-kind="style" className="rounded-md border p-3">
      <div className="flex items-start gap-3">
        <SeverityIcon severity={rule.severity} />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-relaxed">{rule.instruction}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={rule.severity} />
            <Badge variant="outline">{categoryLabel}</Badge>
            {chips}
          </div>
          {rule.conditions && <p className="mt-0.5 text-xs text-muted-foreground">{rule.conditions}</p>}
        </div>
        <Switch
          size="sm"
          checked={rule.enabled}
          disabled={!canManage}
          onCheckedChange={(checked: boolean) => onToggle(checked)}
          aria-label={
            rule.enabled
              ? t("rules.surface.disableRuleAriaLabel", { name: rule.instruction })
              : t("rules.surface.enableRuleAriaLabel", { name: rule.instruction })
          }
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 ps-7">
        <Button size="sm" variant="outline" disabled={!canManage} onClick={onOpenApplicability}>
          {t("terminology.livingMemory.styleRules.library.applicability")}
        </Button>
        {onRefine ? (
          <Button size="sm" variant="ghost" disabled={!canManage} onClick={onRefine}>
            <Sparkles data-icon="inline-start" />
            {t("terminology.livingMemory.styleRules.refine.button")}
          </Button>
        ) : null}
      </div>
    </li>
  )
}
