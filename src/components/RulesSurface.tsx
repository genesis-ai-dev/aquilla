/**
 * RulesSurface — in-shell Rules view for AQU-194.
 *
 * Renders INSIDE the ProjectWorkspace AppShell as the `main` content area.
 * The shell (sidebar, top bar, status bar) stays mounted at all times;
 * only this component swaps in place of the EditorTable.
 */
import { useState, useMemo, useEffect } from "react"
import { useNavigate, useSearchParams, useLocation } from "react-router-dom"
import { Trash2, Wand2, ChevronDown, ChevronUp, Pencil, ArrowUpCircle, Clock, ScrollText, Plus, BookOpen, Layers } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/page"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { AppTooltip } from "@/components/ui/tooltip"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { BuiltinChecksList } from "./BuiltinChecksList"
import { RuleEditor } from "./RuleEditor"
import { OrgRulesPanel } from "@/components/rules/OrgRulesPanel"
import { SeverityBadge, SeverityIcon } from "@/components/rules/RuleSeverity"
import { LaneCombobox } from "@/components/LaneCombobox"
import { rulesForLane, ruleLaneScope, type RuleLaneScope } from "@/lib/rules/rule-engine"
import { extraRegistryLanes } from "@/lib/lanes/registry-lanes"
import { RuleImportDialog } from "./RuleImportDialog"
import { RuleSuggestFromEditsDialog } from "./RuleSuggestFromEditsDialog"
import { editorReturnFromLocation, withEditorReturn } from "@/lib/navigation/org-paths"
import type { CompletionSettings, ProjectRecord, RuleAutofix, TranslationRule, PromotionRequest } from "@/lib/parsers/types"
import type { useRules } from "@/hooks/useRules"
import type { CellData } from "@/hooks/useCells"
import type { OrgWideSettings, OrgPatchResult, PromotionRequestResult } from "@/lib/sync/org-settings"
import { v4 as uuid } from "uuid"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

type UseRulesReturn = ReturnType<typeof useRules>

interface Props {
  project: ProjectRecord
  projectId: string
  userRules: UseRulesReturn["userRules"]
  builtinRules: UseRulesReturn["builtinRules"]
  addRule: UseRulesReturn["addRule"]
  updateRule: UseRulesReturn["updateRule"]
  deleteRule: UseRulesReturn["deleteRule"]
  setBuiltinOverride: UseRulesReturn["setBuiltinOverride"]
  infractions: Map<string, import("@/lib/parsers/types").RuleInfraction[]>
  cells: CellData[]
  /** The corpus behind `cells` is still loading; mining it now would see nothing. */
  cellsLoading?: boolean
  /** The corpus read failed, so `cells` is empty for a reason other than "no edits". */
  cellsError?: Error
  completionSettings?: CompletionSettings
  orgRules?: TranslationRule[]
  canEditOrgRules?: boolean
  patchOrgSettings?: (partial: OrgWideSettings) => Promise<OrgPatchResult | { kind: "blocked" }>
  orgSettingsVersion?: number | null
  promotionRequests?: PromotionRequest[]
  canRequestPromotion?: boolean
  requestPromotion?: (rule: TranslationRule, sourceProjectId: string) => Promise<PromotionRequestResult | { kind: "blocked" }>
  editingRuleId: string | "new" | null
  setEditingRuleId: (id: string | "new" | null) => void
  /** Settings pane: skip the in-main title toolbar; PageHeader owns the title. */
  embedded?: boolean
  /** AQU-1509: the editor's active lane tag (`''` = default lane). When set
   *  with `onActiveLaneChange`, switching lanes here switches the editor too. */
  activeLane?: string
  onActiveLaneChange?: (lane: string) => void
  /** AQU-1699: what the project's decisions and terminology switch on for the Bible data checks. */
  bibleReadiness?: import("../../db/shared/bible-checks/participant-types").BibleCheckReadiness
}

export function RulesSurface({
  project,
  projectId,
  userRules,
  builtinRules,
  addRule,
  updateRule,
  deleteRule,
  setBuiltinOverride,
  infractions,
  cells,
  cellsLoading,
  cellsError,
  completionSettings,
  orgRules = [],
  canEditOrgRules = false,
  patchOrgSettings,
  promotionRequests = [],
  canRequestPromotion = false,
  requestPromotion,
  editingRuleId,
  setEditingRuleId,
  embedded = false,
  activeLane,
  onActiveLaneChange,
  bibleReadiness,
}: Props) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null)
  const [promoteRule, setPromoteRule] = useState<TranslationRule | null>(null)
  const [promoting, setPromoting] = useState(false)
  const [requestedRuleIds, setRequestedRuleIds] = useState<Set<string>>(new Set())
  const [requestingRuleId, setRequestingRuleId] = useState<string | null>(null)
  const [requestNotice, setRequestNotice] = useState<Map<string, string>>(new Map())

  // AQU-609: lane scope for PROJECT rules. Named lanes come from the project
  // record; `''` (the default lane) is labeled with the base target language.
  const projectLanes = extraRegistryLanes(project.targetLanes, project.targetLanguage)
  const laneRows = (project.lanes ?? []).filter((lane) => lane.role === "target")
  const defaultLaneRow = laneRows.find((lane) => (lane.legacyTag ?? "") === "")
  const defaultLaneLabel = defaultLaneRow?.name || project.targetLanguage || undefined
  const laneLabels = Object.fromEntries(
    laneRows.map((lane) => [lane.legacyTag ?? "", lane.name]),
  )

  const laneName = (tag: string): string =>
    laneLabels[tag] || (tag === "" ? defaultLaneLabel || t("rules.editor.lane.defaultLane") : tag)

  // AQU-1509: the page is always viewing ONE lane — the editor's active lane
  // when the workspace shares it, else a local choice. Options are every
  // target lane (same list and order as the editor's lane switcher), searched
  // through LaneCombobox because projects can carry 150+ lanes.
  const [localLane, setLocalLane] = useState("")
  const laneOptions = (() => {
    const tags = laneRows.length > 0
      ? [...laneRows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((lane) => lane.legacyTag ?? "")
      : projectLanes
    const unique = [...new Set(tags)]
    if (!unique.includes("")) unique.unshift("")
    const archived = new Set(laneRows.filter((lane) => lane.archivedAt).map((lane) => lane.legacyTag ?? ""))
    return unique.map((tag) => ({ tag, archived: archived.has(tag) }))
  })()
  const requestedLane = activeLane ?? localLane
  const viewLane = laneOptions.some((o) => o.tag === requestedLane) ? requestedLane : ""
  const setViewLane = onActiveLaneChange ?? setLocalLane
  const hasLaneRules = userRules.some((rule) => rule.scope === "lane")
  const multiLane = laneOptions.length > 1 || hasLaneRules

  // Default: only rules enforced in the viewed lane. Other lanes' rules are
  // one click away and sort last, marked as not applied here.
  const [showOtherLanes, setShowOtherLanes] = useState(false)
  const appliedUserRules = rulesForLane(userRules, viewLane)
  const otherLaneRules = userRules.filter((rule) => ruleLaneScope(rule, viewLane) === "other")
  const visibleUserRules = !multiLane
    ? userRules
    : showOtherLanes ? [...appliedUserRules, ...otherLaneRules] : appliedUserRules

  useEffect(() => {
    const focusId = searchParams.get("ruleId")
    const focus = searchParams.get("focus")
    if (focusId && focus === "autofix") {
      setExpandedRuleId(focusId)
      requestAnimationFrame(() => {
        document.getElementById(`rule-row-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      })
    }
  }, [searchParams])

  const usageSummary = useMemo(() => {
    const u = project?.usage
    if (!u) return null
    const calls = Object.values(u.llmCalls).reduce((s, v) => s + v.total, 0)
    return t("rules.usageSummary", { fixes: u.fixesApplied, calls })
  }, [project?.usage, t])

  async function handlePromoteToOrg(rule: TranslationRule) {
    if (!patchOrgSettings) return
    setPromoting(true)
    const promoted: TranslationRule = {
      ...rule,
      id: uuid(),
      scope: "org",
      lane: undefined, // an org rule applies everywhere — drop any lane pin
      sourceProjectId: projectId,
      createdAt: new Date().toISOString(),
    }
    const newOrgRules = [...orgRules, promoted]
    await patchOrgSettings({ rules: newOrgRules })
    setPromoting(false)
    setPromoteRule(null)
  }

  async function handleRequestPromotion(rule: TranslationRule) {
    if (!requestPromotion) return
    setRequestingRuleId(rule.id)
    const result = await requestPromotion(rule, projectId)
    setRequestingRuleId(null)
    if (result.kind === "ok") {
      setRequestedRuleIds((prev) => new Set([...prev, rule.id]))
      setRequestNotice((prev) => new Map(prev).set(rule.id, t("rules.promotion.requested")))
    } else if (result.kind === "duplicate") {
      setRequestedRuleIds((prev) => new Set([...prev, rule.id]))
      setRequestNotice((prev) => new Map(prev).set(rule.id, t("rules.promotion.alreadyRequested")))
    } else {
      setRequestNotice((prev) => new Map(prev).set(rule.id, t("rules.promotion.requestFailed")))
    }
  }

  function toggleExpanded(ruleId: string) {
    setExpandedRuleId((cur) => cur === ruleId ? null : ruleId)
    const next = new URLSearchParams(searchParams)
    if (next.get("ruleId") === ruleId) next.delete("ruleId"); else next.set("ruleId", ruleId)
    next.delete("focus")
    setSearchParams(next, { replace: true })
  }

  const toolbarActions = (
    <>
      <Button
        variant="outline"
        onClick={() => navigate(withEditorReturn(
          `/project/${projectId}/terminology`,
          editorReturnFromLocation(location.pathname, location.search, projectId),
        ))}
      >
        <BookOpen data-icon="inline-start" />
        {t("nav.sidebarSection.terminology")}
      </Button>
      <RuleImportDialog
        completionSettings={completionSettings}
        onAdd={addRule}
        projectId={projectId}
      />
      <RuleSuggestFromEditsDialog
        completionSettings={completionSettings}
        onAdd={addRule}
        projectId={projectId}
        cells={cells}
        cellsLoading={cellsLoading}
        cellsError={cellsError}
      />
      <Button
        onClick={() => setEditingRuleId("new")}
        disabled={editingRuleId !== null}
      >
        <Plus className="size-4" aria-hidden />
        {t("rules.surface.addRuleButton")}
      </Button>
    </>
  )

  return (
    <div className={embedded ? "flex flex-col gap-6" : "flex h-full flex-col bg-background"}>
      {embedded ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {toolbarActions}
        </div>
      ) : (
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          <ScrollText className="h-5 w-5 text-muted-foreground" aria-hidden />
          <h1 className="flex-1 text-base font-semibold">{t("nav.sidebarSection.rules")}</h1>
          {toolbarActions}
        </header>
      )}

      {/* Create project rule — dialog, not inline */}
      <Dialog
        open={editingRuleId === "new"}
        onOpenChange={(open) => { if (!open) setEditingRuleId(null) }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-h-[90vh] max-w-2xl gap-0 overflow-y-auto p-0 sm:max-w-2xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{t("rules.surface.createRuleDialog.title")}</DialogTitle>
            <DialogDescription>{t("rules.surface.createRuleDialog.description")}</DialogDescription>
          </DialogHeader>
          {/* shrink-0: the editor root clips its own overflow, so as a flex
              item it would shrink to the dialog height and hide its footer
              instead of letting DialogContent scroll. */}
          <RuleEditor
            className="shrink-0 rounded-none border-0"
            cells={cells}
            lanes={projectLanes}
            laneLabels={laneLabels}
            defaultLaneLabel={defaultLaneLabel}
            onSave={async (rule) => {
              await addRule(rule)
              setEditingRuleId(null)
            }}
            onCancel={() => setEditingRuleId(null)}
          />
        </DialogContent>
      </Dialog>

      <div className={embedded ? "flex flex-col gap-6" : "min-h-0 flex-1 overflow-y-auto"}>
        <div className={embedded ? "flex flex-col gap-6" : "mx-auto flex max-w-2xl flex-col gap-6 p-6"}>
        {usageSummary && (
          <AppTooltip content={t("rules.surface.usageTooltip")}>
            <p className="text-xs text-muted-foreground">{usageSummary}</p>
          </AppTooltip>
        )}

        {multiLane && (
          <section
            aria-label={t("rules.surface.laneScope.ariaLabel")}
            data-testid="rules-lane-scope"
            className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Layers className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium">{t("rules.surface.laneScope.viewingLabel")}</span>
              <LaneCombobox
                options={laneOptions.map((o) => ({ value: o.tag, label: laneName(o.tag), archived: o.archived }))}
                value={viewLane}
                onValueChange={setViewLane}
                searchPlaceholder={t("editor.lane.searchPlaceholder")}
                searchAriaLabel={t("editor.lane.searchAriaLabel")}
                emptyText={t("editor.lane.searchEmpty")}
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("rules.surface.laneScope.chooseLaneAriaLabel", { lane: laneName(viewLane) })}
                  >
                    {laneName(viewLane)}
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  </Button>
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("rules.surface.laneScope.explainer", { lane: laneName(viewLane) })}
              {onActiveLaneChange && ` ${t("rules.surface.laneScope.sharedWithEditor")}`}
            </p>
          </section>
        )}

        {/* Card order is most-specific scope first: project rules (incl.
            lane-scoped) → org rules → app built-ins (AQU-609 feedback). */}
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{t("rules.surface.projectRulesCardTitle", { count: userRules.length })}</CardTitle>
              {multiLane && otherLaneRules.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ms-auto"
                  aria-pressed={showOtherLanes}
                  onClick={() => setShowOtherLanes((v) => !v)}
                >
                  {showOtherLanes
                    ? t("rules.surface.laneScope.hideOtherLanes")
                    : t("rules.surface.laneScope.showOtherLanes", { count: otherLaneRules.length })}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {userRules.length === 0 ? (
              <EmptyState
                variant="inline"
                className="px-0 py-4"
                icon={ScrollText}
                title={t("rules.surface.noProjectRules.title")}
                description={
                  <>
                    {t("rules.surface.noProjectRules.description")}
                    {canEditOrgRules && orgRules.length > 0 && ` ${t("rules.surface.noProjectRules.orgRulesNote")}`}
                  </>
                }
              />
            ) : visibleUserRules.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                {t("rules.surface.laneScope.noRulesInLane", { lane: laneName(viewLane) })}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {visibleUserRules.map((rule) => {
                  const expanded = expandedRuleId === rule.id
                  const laneScope = ruleLaneScope(rule, viewLane)
                  return (
                    <li
                      key={rule.id}
                      id={`rule-row-${rule.id}`}
                      data-lane-scope={multiLane ? laneScope : undefined}
                      className={cn("rounded-md border p-3", multiLane && laneScope === "other" && "border-dashed bg-muted/30")}
                    >
                      {/* Two-row layout: text + badges get the full width (with
                          compact icon actions on the right); the wide buttons
                          and the Enabled switch live on their own line below —
                          one long name must never smush into the action row. */}
                      <div className="flex items-start gap-3">
                        <SeverityIcon severity={rule.severity} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium">{rule.name}</span>
                            <SeverityBadge severity={rule.severity} />
                            <Badge variant="secondary">{rule.source}</Badge>
                            {multiLane && <LaneScopeBadge scope={laneScope} laneLabel={laneName(rule.lane ?? "")} />}
                            {rule.autofix && <Badge variant="outline">{t("rules.surface.autofixBadge")}</Badge>}
                          </div>
                          {rule.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{rule.description}</p>}
                          {multiLane && laneScope === "other" && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {t("rules.surface.laneScope.notAppliedHere", { lane: laneName(viewLane) })}
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
                          <Button variant="ghost" onClick={() => toggleExpanded(rule.id)}>
                            {expanded ? <ChevronUp /> : <ChevronDown />}
                          </Button>
                          <Button variant="ghost" onClick={() => deleteRule(rule.id)}>
                            <Trash2 />
                          </Button>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 ps-7">
                        <AppTooltip content={t("rules.surface.tryToFixAllTooltip")}>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => navigate(`/project/${projectId}/editor?openRule=${rule.id}`)}
                          >
                            <Wand2 data-icon="inline-start" />
                            {t("rules.surface.tryToFixAllButton")}
                          </Button>
                        </AppTooltip>
                        {canEditOrgRules && patchOrgSettings && (
                          <AppTooltip content={t("rules.surface.promoteToOrgTooltip")}>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPromoteRule(rule)}
                          >
                            <ArrowUpCircle data-icon="inline-start" />
                            {t("rules.surface.promoteToOrgButton")}
                          </Button>
                          </AppTooltip>
                        )}
                        {!canEditOrgRules && canRequestPromotion && requestPromotion && (
                          (() => {
                            const alreadyRequested = requestedRuleIds.has(rule.id) ||
                              promotionRequests.some((r) => r.rule.id === rule.id && r.sourceProjectId === projectId)
                            const notice = requestNotice.get(rule.id)
                            const isRequesting = requestingRuleId === rule.id
                            return alreadyRequested || notice ? (
                              <Badge variant="secondary">
                                <Clock data-icon="inline-start" />
                                {notice ?? t("rules.surface.requestedBadge")}
                              </Badge>
                            ) : (
                              <AppTooltip content={t("rules.surface.requestPromotionTooltip")}>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleRequestPromotion(rule)}
                                  disabled={isRequesting}
                                >
                                  <ArrowUpCircle data-icon="inline-start" />
                                  {isRequesting ? t("rules.surface.requestingButton") : t("rules.surface.requestPromotionButton")}
                                </Button>
                              </AppTooltip>
                            )
                          })()
                        )}
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

                      {expanded && (
                        <AutofixEditor rule={rule} onUpdate={(af) => updateRule(rule.id, { autofix: af })} />
                      )}
                      {editingRuleId === rule.id && (
                        <>
                          <Separator className="my-3" />
                          <RuleEditor
                            initialRule={rule}
                            cells={cells}
                            lanes={projectLanes}
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
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Org rules — AQU-1131 extracted this into OrgRulesPanel so the same
            library also renders standalone at /orgs/:orgId/settings/rules. */}
        <OrgRulesPanel
          orgRules={orgRules}
          canEdit={canEditOrgRules}
          patchOrgSettings={patchOrgSettings}
          promotionRequests={promotionRequests}
          cells={cells}
          hideWhenEmpty
        />

        {/* Promote confirmation dialog */}
        {promoteRule && (
          <Dialog open onOpenChange={(open) => { if (!open) setPromoteRule(null) }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("rules.surface.promoteDialog.title")}</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                <RichMessage
                  k="rules.surface.promoteDialog.body"
                  values={{ name: <strong>{promoteRule.name}</strong> }}
                />
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPromoteRule(null)}>{t("common.cancel")}</Button>
                <Button onClick={() => handlePromoteToOrg(promoteRule)} disabled={promoting}>
                  {promoting ? t("rules.surface.promoteDialog.promoting") : t("rules.surface.promoteToOrgButton")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        <BuiltinChecksList
          builtinRules={builtinRules}
          infractions={infractions}
          onSetOverride={setBuiltinOverride}
          languageProfile={project.languageProfile}
          bibleReadiness={bibleReadiness}
        />
        </div>
      </div>
    </div>
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

/** AQU-1509: states a project rule's lane scope relative to the viewed lane. */
function LaneScopeBadge({ scope, laneLabel }: { scope: RuleLaneScope; laneLabel: string }) {
  const t = useT()
  if (scope === "all") return <Badge variant="secondary">{t("rules.surface.laneScope.badgeAll")}</Badge>
  if (scope === "this") return <Badge>{t("rules.surface.laneScope.badgeThis", { lane: laneLabel })}</Badge>
  return <Badge variant="outline" className="border-dashed">{t("rules.surface.laneScope.badgeOther", { lane: laneLabel })}</Badge>
}
