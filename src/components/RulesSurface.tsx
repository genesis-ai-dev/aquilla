/**
 * RulesSurface — the Living Memory → Checks pane (AQU-194; AQU-2342).
 *
 * AQU-2342: every check the project runs is ONE list — project rules (and
 * lane-scoped ones), the organization's rules, style rules and the built-in
 * checks — each row naming its scope with a chip, most specific first
 * (./checks/check-rows.ts). The stores stay as they were; only the showing is
 * one. Each row opens the editor its store already has, and one "Add check"
 * button starts every kind of new check.
 */
import { useState, useMemo, useEffect, useRef, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { Plus, Layers, ChevronDown, Clock, ShieldCheck } from "lucide-react"
import { Link } from "react-router-dom"
import { v4 as uuid } from "uuid"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/page"
import { NoteOnClick } from "@/components/ui/info-note"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { BuiltinCheckRow, useBuiltinCounts } from "./BuiltinChecksList"
import { RuleEditor } from "./RuleEditor"
import { LaneCombobox } from "@/components/LaneCombobox"
import { rulesForLane, ruleLaneScope } from "@/lib/rules/rule-engine"
import { withBuiltinOverrides } from "@/lib/lqa/builtin-resolver"
import { laneCheckOverrides, laneLanguageForChecks, laneLanguageLabel, lanePunctuation } from "@/lib/lqa/lane-builtin-checks"
import { extraRegistryLanes } from "@/lib/lanes/registry-lanes"
import { switcherLaneTags } from "@/lib/lanes/switcher-lanes"
import { RuleImportDialog } from "./RuleImportDialog"
import { RuleSuggestionItem, RuleSuggestionsFooter } from "@/components/rules/RuleSuggestions"
import { useRuleSuggestions } from "@/hooks/useRuleSuggestions"
import { useFlipAnimation } from "@/hooks/useFlipAnimation"
import { orgSettingsPath } from "@/lib/navigation/org-paths"
import type { CompletionSettings, ProjectRecord, TranslationRule, PromotionRequest } from "@/lib/parsers/types"
import type { useRules } from "@/hooks/useRules"
import type { CellData } from "@/hooks/useCells"
import type { OrgWideSettings, OrgPatchResult, PromotionRequestResult } from "@/lib/sync/org-settings"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { laneDisplayName } from "@/lib/lanes/lane-display"
import { readLanguageProfile } from "../../db/shared/language-profile"
import { buildCheckRows, type CheckRow } from "./checks/check-rows"
import { ScopeChips } from "./checks/ScopeChips"
import { ProjectRuleRow } from "./checks/ProjectRuleRow"
import { OrgCheckRow, StyleCheckRow } from "./checks/OtherCheckRows"
import { AddCheckDialog } from "./checks/AddCheckDialog"
import type { StyleChecksBinding } from "./living-memory/StyleChecks"

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
  /** AQU-1906: the built-in overrides as they stand right now, optimistic
   *  writes included (PR #1438), so a built-in toggle moves at once on this page.
   *  Absent, the viewed lane resolves from the record itself. */
  checkOverrides?: UseRulesReturn["checkOverrides"]
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
  /** Kept for callers; the pane always renders embedded now. */
  embedded?: boolean
  /** AQU-1509: the editor's active lane tag (`''` = default lane). When set
   *  with `onActiveLaneChange`, switching lanes here switches the editor too. */
  activeLane?: string
  onActiveLaneChange?: (lane: string) => void
  /** AQU-1699: what the project's decisions and terminology switch on for the Bible data checks. */
  bibleReadiness?: import("../../db/shared/bible-checks/participant-types").BibleCheckReadiness
  /** AQU-2342: the style-rule store, as rows of this list (./living-memory/StyleChecks). */
  style?: StyleChecksBinding
  /** Data the checks read (Language profile, document genres), under the list. */
  checkData?: ReactNode
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
  checkOverrides,
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
  activeLane,
  onActiveLaneChange,
  bibleReadiness,
  style,
  checkData,
}: Props) {
  const t = useT()
  const [searchParams, setSearchParams] = useSearchParams()
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null)
  const [promoteRule, setPromoteRule] = useState<TranslationRule | null>(null)
  const [promoting, setPromoting] = useState(false)
  const [requestedRuleIds, setRequestedRuleIds] = useState<Set<string>>(new Set())
  const [requestingRuleId, setRequestingRuleId] = useState<string | null>(null)
  const [requestNotice, setRequestNotice] = useState<Map<string, string>>(new Map())
  const [addOpen, setAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editingOrgRuleId, setEditingOrgRuleId] = useState<string | "new" | null>(null)

  // AQU-609: lane scope for PROJECT rules. Named lanes come from the project
  // record; `''` (the default lane) is labeled with the base target language.
  const projectLanes = extraRegistryLanes(project.targetLanes, project.targetLanguage)
  const laneRows = (project.lanes ?? []).filter((lane) => lane.role === "target")
  const defaultLaneRow = laneRows.find((lane) => (lane.legacyTag ?? "") === "")
  const defaultLaneLabel = defaultLaneRow
    ? laneDisplayName(defaultLaneRow)
    : project.targetLanguage || undefined
  // AQU-1592: a lane's label is its display name — the name when the user set
  // one, else the language it carries.
  const laneLabels = Object.fromEntries(
    laneRows.map((lane) => [lane.legacyTag ?? "", laneDisplayName(lane)]),
  )
  const laneName = (tag: string): string =>
    laneLabels[tag] || (tag === "" ? defaultLaneLabel || t("rules.editor.lane.defaultLane") : tag)
  const fileNames = useMemo(
    () => new Map((project.files ?? []).map((file) => [file.id, file.name])),
    [project.files],
  )

  // AQU-1509: the page is always viewing ONE lane — the editor's active lane
  // when the workspace shares it, else a local choice.
  const [localLane, setLocalLane] = useState("")
  const laneOptions = (() => {
    const fallback = [...new Set(projectLanes)]
    if (!fallback.includes("")) fallback.unshift("")
    const tags = switcherLaneTags(laneRows, fallback)
    const archived = new Set(laneRows.filter((lane) => lane.archivedAt).map((lane) => lane.legacyTag ?? ""))
    return tags.map((tag) => ({ tag, archived: archived.has(tag) }))
  })()
  const requestedLane = activeLane ?? localLane
  const viewLane = laneOptions.some((o) => o.tag === requestedLane)
    ? requestedLane
    : (laneOptions[0]?.tag ?? "")
  const setViewLane = onActiveLaneChange ?? setLocalLane
  const hasLaneRules = userRules.some((rule) => rule.scope === "lane")
  const multiLane = laneOptions.length > 1 || hasLaneRules
  // AQU-1906: a built-in check's switch and severity apply to ONE lane once the
  // project HAS more than one; with a single lane they stay project-wide.
  const perLaneChecks = laneOptions.length > 1
  const lanePunctuationResolved = lanePunctuation(project, viewLane)
  const laneBuiltinRules = withBuiltinOverrides(
    builtinRules,
    laneCheckOverrides(checkOverrides ?? project, viewLane),
    lanePunctuationResolved.conventions,
  )
  const punctuationOrigin = lanePunctuationResolved.origin
  // AQU-2000: a source-relative origin means either the lane records no
  // language, or it records one the conventions table has no entry for.
  const viewLaneHasLanguage = laneLanguageForChecks(project, viewLane).trim() !== ""
  const punctuationNote =
    punctuationOrigin.kind === "profile"
      ? t("rules.builtinChecks.punctuation.fromProfile")
      : punctuationOrigin.kind === "language"
        ? t("rules.builtinChecks.punctuation.fromLanguage", {
            language: laneLanguageLabel(project, viewLane),
          })
        : viewLaneHasLanguage
          ? t("rules.builtinChecks.punctuation.noSpecialConventions", {
              language: laneLanguageLabel(project, viewLane),
            })
          : t("rules.builtinChecks.punctuation.sourceRelative")

  // Default: only rules enforced in the viewed lane. Other lanes' rules are
  // one click away and sort last, marked as not applied here.
  const [showOtherLanes, setShowOtherLanes] = useState(false)
  const otherLaneRules = userRules.filter((rule) => ruleLaneScope(rule, viewLane) === "other")
  const appliedUserRules = rulesForLane(userRules, viewLane)

  const rows = buildCheckRows({
    userRules: multiLane ? userRules : appliedUserRules,
    orgRules,
    builtinRules: laneBuiltinRules,
    styleRules: style?.rules,
    styleApplicability: style?.applicability,
    viewLane,
    multiLane,
    showOtherLanes,
  })
  const builtinCounts = useBuiltinCounts(infractions)
  const profile = readLanguageProfile(project.languageProfile)

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
    await patchOrgSettings({ rules: [...orgRules, promoted] })
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

  async function updateOrgRule(ruleId: string, updates: Partial<TranslationRule>) {
    if (!patchOrgSettings) return
    await patchOrgSettings({ rules: orgRules.map((r) => (r.id === ruleId ? { ...r, ...updates } : r)) })
  }
  async function deleteOrgRule(ruleId: string) {
    if (!patchOrgSettings) return
    await patchOrgSettings({ rules: orgRules.filter((r) => r.id !== ruleId) })
  }
  async function addOrgRule(rule: Omit<TranslationRule, "id" | "createdAt">) {
    if (!patchOrgSettings) return
    const newRule: TranslationRule = { ...rule, id: uuid(), scope: "org", createdAt: new Date().toISOString() }
    await patchOrgSettings({ rules: [...orgRules, newRule] })
  }

  // Suggested rules are reviewed in place at the bottom of the list;
  // approving one hands its row over to the saved rule, animated.
  const suggestions = useRuleSuggestions({
    projectId,
    completionSettings,
    cells,
    cellsLoading: cellsLoading ?? false,
    cellsError,
    userRules,
    addRule,
  })
  const listRef = useRef<HTMLUListElement>(null)
  useFlipAnimation(listRef)

  function toggleExpanded(ruleId: string) {
    setExpandedRuleId((cur) => cur === ruleId ? null : ruleId)
    const next = new URLSearchParams(searchParams)
    if (next.get("ruleId") === ruleId) next.delete("ruleId"); else next.set("ruleId", ruleId)
    next.delete("focus")
    setSearchParams(next, { replace: true })
  }

  const chipsFor = (row: CheckRow) => (
    <ScopeChips chips={row.chips} laneName={laneName} fileName={(id) => fileNames.get(id) ?? id} />
  )

  const renderRow = (row: CheckRow) => {
    switch (row.kind) {
      case "project": {
        const { rule } = row
        const other = multiLane && ruleLaneScope(rule, viewLane) === "other"
        const alreadyRequested = requestedRuleIds.has(rule.id) ||
          promotionRequests.some((r) => r.rule.id === rule.id && r.sourceProjectId === projectId)
        return (
          <ProjectRuleRow
            key={row.key}
            rule={rule}
            projectId={projectId}
            chips={chipsFor(row)}
            otherLane={other ? { viewLaneName: laneName(viewLane) } : undefined}
            expanded={expandedRuleId === rule.id}
            onToggleExpanded={() => toggleExpanded(rule.id)}
            editingRuleId={editingRuleId}
            setEditingRuleId={setEditingRuleId}
            updateRule={updateRule}
            deleteRule={deleteRule}
            cells={cells}
            lanes={projectLanes}
            laneLabels={laneLabels}
            defaultLaneLabel={defaultLaneLabel}
            onPromote={canEditOrgRules && patchOrgSettings ? () => setPromoteRule(rule) : undefined}
            promotion={
              !canEditOrgRules && canRequestPromotion && requestPromotion
                ? {
                    requested: alreadyRequested,
                    notice: requestNotice.get(rule.id),
                    requesting: requestingRuleId === rule.id,
                    onRequest: () => void handleRequestPromotion(rule),
                  }
                : undefined
            }
            flipFrom={(() => {
              const id = suggestions.adoptedDraftId(rule)
              return id ? `draft-${id}` : undefined
            })()}
            multiLane={multiLane}
          />
        )
      }
      case "org":
        return (
          <OrgCheckRow
            key={row.key}
            rule={row.rule}
            chips={chipsFor(row)}
            canEdit={canEditOrgRules && patchOrgSettings != null}
            editing={editingOrgRuleId === row.rule.id}
            onEdit={() => setEditingOrgRuleId(editingOrgRuleId === row.rule.id ? null : row.rule.id)}
            onCancelEdit={() => setEditingOrgRuleId(null)}
            onUpdate={(updates) => updateOrgRule(row.rule.id, updates)}
            onDelete={() => void deleteOrgRule(row.rule.id)}
            cells={cells}
          />
        )
      case "style": {
        if (!style) return null
        const rule = row.rule
        return (
          <StyleCheckRow
            key={row.key}
            rule={rule}
            chips={chipsFor(row)}
            categoryLabel={style.labels.category[rule.category]}
            canManage={style.canManage}
            onToggle={(enabled) => style.toggle(rule, enabled)}
            onOpenApplicability={() => style.openApplicability(rule)}
            onRefine={style.refine ? () => style.refine?.(rule) : undefined}
          />
        )
      }
      case "builtin":
        return (
          <BuiltinCheckRow
            key={row.key}
            rule={row.rule}
            count={builtinCounts.get(row.rule.id) ?? 0}
            onSetOverride={(checkId, override) =>
              setBuiltinOverride(checkId, override, perLaneChecks ? viewLane : undefined)
            }
            profile={profile}
            bibleReadiness={bibleReadiness}
            punctuationNote={punctuationNote}
            leading={chipsFor(row)}
            className="flex items-center gap-3 rounded-md border p-3 text-sm"
          />
        )
    }
  }

  const userRuleCount = rows.filter((row) => row.kind !== "builtin").length
  const pendingOrgRequests = canEditOrgRules ? promotionRequests.length : 0

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
          {t("rules.checks.intro")}
        </p>
        <Button onClick={() => setAddOpen(true)} disabled={editingRuleId !== null}>
          <Plus className="size-4" aria-hidden />
          {t("rules.checks.addButton")}
        </Button>
      </div>

      <AddCheckDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onPattern={() => setEditingRuleId("new")}
        onImport={() => setImportOpen(true)}
        onExtract={style?.extract}
        onOrgPattern={canEditOrgRules && patchOrgSettings ? () => setEditingOrgRuleId("new") : undefined}
      />
      <RuleImportDialog
        completionSettings={completionSettings}
        onAdd={addRule}
        projectId={projectId}
        open={importOpen}
        onOpenChange={setImportOpen}
      />

      {/* Create a project check — dialog, not inline */}
      <Dialog open={editingRuleId === "new"} onOpenChange={(open) => { if (!open) setEditingRuleId(null) }}>
        <DialogContent showCloseButton={false} className="max-h-[90vh] max-w-2xl gap-0 overflow-y-auto p-0 sm:max-w-2xl">
          <DialogHeader className="sr-only">
            <DialogTitle>{t("rules.surface.createRuleDialog.title")}</DialogTitle>
            <DialogDescription>{t("rules.surface.createRuleDialog.description")}</DialogDescription>
          </DialogHeader>
          {/* shrink-0: the editor root clips its own overflow, so as a flex
              item it would shrink to the dialog height and hide its footer. */}
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

      {/* Create an organization check */}
      <Dialog open={editingOrgRuleId === "new"} onOpenChange={(open) => { if (!open) setEditingOrgRuleId(null) }}>
        <DialogContent showCloseButton={false} className="max-h-[90vh] max-w-2xl gap-0 overflow-y-auto p-0 sm:max-w-2xl">
          <DialogHeader className="sr-only">
            <DialogTitle>{t("rules.surface.createOrgRuleDialog.title")}</DialogTitle>
            <DialogDescription>{t("rules.surface.createOrgRuleDialog.description")}</DialogDescription>
          </DialogHeader>
          <RuleEditor
            className="shrink-0 rounded-none border-0"
            cells={cells}
            onSave={async (rule) => {
              await addOrgRule(rule)
              setEditingOrgRuleId(null)
            }}
            onCancel={() => setEditingOrgRuleId(null)}
          />
        </DialogContent>
      </Dialog>

      {/* AQU-2260: what the line counts opens on click, never on hover. */}
      {usageSummary && (
        <p className="text-xs text-muted-foreground">
          <NoteOnClick note={t("rules.surface.usageTooltip")} align="start">
            {usageSummary}
          </NoteOnClick>
        </p>
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
          {perLaneChecks && (
            <p data-testid="builtin-checks-lane-note" className="text-xs text-muted-foreground">
              {t("rules.builtinChecks.laneScopeNote", { lane: laneName(viewLane) })}
            </p>
          )}
        </section>
      )}

      {style?.errorBanner}

      <section aria-label={t("rules.checks.listTitle")} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xs font-semibold text-muted-foreground">{t("rules.checks.listTitle")}</h2>
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
        {userRuleCount === 0 && (
          <EmptyState
            variant="inline"
            className="px-0 py-2"
            icon={ShieldCheck}
            title={t("rules.checks.empty.title")}
            description={t("rules.checks.empty.description")}
          />
        )}
        <ul ref={listRef} className="relative flex flex-col gap-2" data-testid="checks-list">
          {rows.map(renderRow)}
          {suggestions.drafts.map((draft) => (
            <RuleSuggestionItem
              key={draft.id}
              draft={draft}
              onApprove={suggestions.approve}
              onDismiss={suggestions.dismiss}
            />
          ))}
          <RuleSuggestionsFooter
            onSuggest={suggestions.suggest}
            hasSuggested={suggestions.hasSuggested}
            loading={suggestions.loading}
            message={suggestions.message}
            isConfigured={suggestions.isConfigured}
            cellsLoading={cellsLoading ?? false}
            cellsError={cellsError}
          />
        </ul>
        {pendingOrgRequests > 0 && project.orgId != null && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5" aria-hidden />
            <Link className="underline underline-offset-2" to={orgSettingsPath(project.orgId, "rules")}>
              {t("rules.surface.pendingRequests", { count: pendingOrgRequests })}
            </Link>
          </p>
        )}
      </section>

      {style?.reviewQueue}
      {checkData}

      {/* Promote confirmation dialog */}
      {promoteRule && (
        <Dialog open onOpenChange={(open) => { if (!open) setPromoteRule(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("rules.surface.promoteDialog.title")}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              <RichMessage k="rules.surface.promoteDialog.body" values={{ name: <strong>{promoteRule.name}</strong> }} />
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
    </div>
  )
}
