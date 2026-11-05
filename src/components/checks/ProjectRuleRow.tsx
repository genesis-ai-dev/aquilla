/**
 * One project rule's row in the unified Checks list (AQU-2342) — moved out of
 * RulesSurface's old "Project Rules" card unchanged in behaviour: edit in
 * place (RuleEditor), autofix, "Try to fix all", promote to the organization
 * or request promotion, and the enabled switch.
 */
import { useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowUpCircle, ChevronDown, ChevronUp, Clock, Pencil, Trash2, Wand2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { AppTooltip } from "@/components/ui/tooltip"
import { RuleEditor } from "@/components/RuleEditor"
import { SeverityBadge, SeverityIcon } from "@/components/rules/RuleSeverity"
import { useT } from "@/lib/i18n/I18nProvider"
import type { CellData } from "@/hooks/useCells"
import type { RuleAutofix, TranslationRule } from "@/lib/parsers/types"

export interface ProjectRuleRowProps {
  rule: TranslationRule
  projectId: string
  /** Scope chip(s), rendered after the name. */
  chips: ReactNode
  /** Another lane's rule, shown on request: dashed and explained. */
  otherLane?: { viewLaneName: string }
  expanded: boolean
  onToggleExpanded: () => void
  editingRuleId: string | "new" | null
  setEditingRuleId: (id: string | "new" | null) => void
  updateRule: (id: string, updates: Partial<TranslationRule>) => void | Promise<void>
  deleteRule: (id: string) => void | Promise<void>
  /** RuleEditor's match preview + lane options. */
  cells: CellData[]
  lanes: string[]
  laneLabels: Record<string, string>
  defaultLaneLabel?: string
  /** Org maintainers: open the promote confirmation. */
  onPromote?: () => void
  /** Others who may request promotion. */
  promotion?: {
    requested: boolean
    notice?: string
    requesting: boolean
    onRequest: () => void
  }
  /** Approved from a suggestion this session: animate in from that row. */
  flipFrom?: string
  multiLane: boolean
}

export function ProjectRuleRow({
  rule,
  projectId,
  chips,
  otherLane,
  expanded,
  onToggleExpanded,
  editingRuleId,
  setEditingRuleId,
  updateRule,
  deleteRule,
  cells,
  lanes,
  laneLabels,
  defaultLaneLabel,
  onPromote,
  promotion,
  flipFrom,
  multiLane,
}: ProjectRuleRowProps) {
  const t = useT()
  const navigate = useNavigate()
  return (
    <li
      id={`rule-row-${rule.id}`}
      data-flip-key={rule.id}
      data-flip-from={flipFrom}
      data-check-kind="project"
      data-lane-scope={multiLane ? (otherLane ? "other" : undefined) : undefined}
      className={cn("rounded-md border p-3", otherLane && "border-dashed bg-muted/30")}
    >
      {/* Two-row layout: text + badges get the full width (with compact icon
          actions on the right); the wide buttons and the Enabled switch live
          on their own line below — one long name must never smush into the
          action row. */}
      <div className="flex items-start gap-3">
        <SeverityIcon severity={rule.severity} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{rule.name}</span>
            <SeverityBadge severity={rule.severity} />
            {chips}
            {rule.autofix && <Badge variant="outline">{t("rules.surface.autofixBadge")}</Badge>}
          </div>
          {rule.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{rule.description}</p>}
          {otherLane && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("rules.surface.laneScope.notAppliedHere", { lane: otherLane.viewLaneName })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <AppTooltip content={t("rules.editor.editRuleHeading")}>
            <Button
              variant="ghost"
              onClick={() => setEditingRuleId(editingRuleId === rule.id ? null : rule.id)}
              disabled={editingRuleId !== null && editingRuleId !== rule.id}
              aria-label={t("rules.editor.editRuleHeading")}
            >
              <Pencil />
            </Button>
          </AppTooltip>
          <Button variant="ghost" onClick={onToggleExpanded} aria-label={t("rules.surface.autofixEditor.heading")}>
            {expanded ? <ChevronUp /> : <ChevronDown />}
          </Button>
          <Button variant="ghost" onClick={() => deleteRule(rule.id)} aria-label={t("common.delete")}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 ps-7">
        {/* AQU-2260: labelled buttons say nothing on hover. */}
        <Button size="sm" variant="outline" onClick={() => navigate(`/project/${projectId}/editor?openRule=${rule.id}`)}>
          <Wand2 data-icon="inline-start" />
          {t("rules.surface.tryToFixAllButton")}
        </Button>
        {onPromote && (
          <Button size="sm" variant="outline" onClick={onPromote}>
            <ArrowUpCircle data-icon="inline-start" />
            {t("rules.surface.promoteToOrgButton")}
          </Button>
        )}
        {promotion &&
          (promotion.requested || promotion.notice ? (
            <Badge variant="secondary">
              <Clock data-icon="inline-start" />
              {promotion.notice ?? t("rules.surface.requestedBadge")}
            </Badge>
          ) : (
            <Button size="sm" variant="outline" onClick={promotion.onRequest} disabled={promotion.requesting}>
              <ArrowUpCircle data-icon="inline-start" />
              {promotion.requesting ? t("rules.surface.requestingButton") : t("rules.surface.requestPromotionButton")}
            </Button>
          ))}
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={rule.enabled}
            onCheckedChange={(checked) => updateRule(rule.id, { enabled: checked })}
            aria-label={
              rule.enabled
                ? t("rules.surface.disableRuleAriaLabel", { name: rule.name })
                : t("rules.surface.enableRuleAriaLabel", { name: rule.name })
            }
          />
          {t("rules.surface.enabledLabel")}
        </label>
      </div>

      {expanded && <AutofixEditor rule={rule} onUpdate={(af) => updateRule(rule.id, { autofix: af })} />}
      {editingRuleId === rule.id && (
        <>
          <Separator className="my-3" />
          <RuleEditor
            initialRule={rule}
            cells={cells}
            lanes={lanes}
            laneLabels={laneLabels}
            defaultLaneLabel={defaultLaneLabel}
            onSave={async (updates) => {
              await updateRule(rule.id, updates)
              setEditingRuleId(null)
            }}
            onCancel={() => setEditingRuleId(null)}
          />
        </>
      )}
    </li>
  )
}

function AutofixEditor({ rule, onUpdate }: { rule: TranslationRule; onUpdate: (af: RuleAutofix | undefined) => void }) {
  const t = useT()
  const [pattern, setPattern] = useState(rule.autofix?.pattern ?? "")
  const [replacement, setReplacement] = useState(rule.autofix?.replacement ?? "")
  const [flags, setFlags] = useState(rule.autofix?.flags ?? "gi")

  return (
    <>
      <Separator className="my-3" />
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">{t("rules.surface.autofixEditor.heading")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input data-autofix-field="pattern" placeholder={t("rules.editor.patternLabel")} value={pattern} onChange={(e) => setPattern(e.target.value)} />
          <Input placeholder={t("rules.surface.autofixEditor.replacementPlaceholder")} value={replacement} onChange={(e) => setReplacement(e.target.value)} />
          <Input placeholder={t("rules.surface.autofixEditor.flagsPlaceholder")} value={flags} onChange={(e) => setFlags(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onUpdate(pattern ? { kind: "regex-replace", pattern, replacement, flags } : undefined)}>
            {t("rules.surface.autofixEditor.saveButton")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onUpdate(undefined)}>{t("common.clear")}</Button>
        </div>
      </div>
    </>
  )
}
