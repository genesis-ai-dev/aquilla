import { useCallback, useState } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { X, AlertTriangle, AlertCircle, Sparkles, Wand2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import type { CompletionSettings, TranslationRule, RuleInfraction, ProjectRecord } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { translateRuleName, translateRuleDescription } from "@/lib/lqa/builtin-resolver"
import { RightSidebarPanel } from "./RightSidebarPanel"
import { FixReviewPanel } from "./FixReviewPanel"
import { editorReturnFromLocation, withEditorReturn } from "@/lib/navigation/org-paths"
import { isCompletionConfigured } from "@/lib/completion/completion-service"
import {
  buildRegexProposal,
  requestBatchFix,
  requestSurgicalFix,
  type FixPreview,
  type FixProposal,
  type ProposalKind,
} from "@/lib/rules/autofix"

interface RuleDrawerProps {
  rule: TranslationRule | null
  infractions: RuleInfraction[]
  cells: CellData[]
  onClose: () => void
  onNavigateToCell: (cellId: string) => void
  project: ProjectRecord | null
  username?: string
  refresh?: () => void
  cellsByFile?: Map<string, CellData[]>
  /** AQU-1805: needed to ask the model for a fix. Absent = no AI fix offered. */
  completionSettings?: CompletionSettings
  session?: FrontierSession | null
  /**
   * AQU-1805: commit a reviewed fix. The drawer proposes; the host writes,
   * because the commit path (optimistic edit, chain-head resolution, IDML
   * anchor protection, outbox flush, revalidation) lives there. Absent =
   * the user may not apply fixes here (read-only, or role below the
   * harmonize floor), and the fix affordances render disabled.
   */
  onApplyFix?: (previews: FixPreview[], proposalKind: ProposalKind) => Promise<void>
}

export function RuleDrawer({
  rule, infractions, cells, onClose, onNavigateToCell,
  project, completionSettings, session, onApplyFix,
}: RuleDrawerProps) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()

  // AQU-1805: the proposal under review. `null` = no review open. Held here
  // rather than in the host so closing the sheet cannot lose the drawer's
  // place in the rule it was opened on.
  const [proposal, setProposal] = useState<FixProposal | null>(null)
  // Which affordance is waiting on the model: a cell id, or "all".
  const [busy, setBusy] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  const canApply = onApplyFix != null
  const aiReady = completionSettings != null &&
    isCompletionConfigured(completionSettings, session?.jwt ?? null)

  const proposeForCell = useCallback(async (cell: CellData) => {
    if (!rule || !completionSettings) return
    setBusy(cell.id)
    try {
      // A `kind: "none"` proposal still opens the sheet: it carries the
      // model's reason, and silently doing nothing is the defect AQU-1805
      // was filed for.
      setProposal(await requestSurgicalFix({
        rule, cell, settings: completionSettings, session: session ?? null,
      }))
    } finally {
      setBusy(null)
    }
  }, [rule, completionSettings, session])

  const proposeForAll = useCallback(async (
    violatingCells: CellData[],
    passingCells: CellData[],
  ) => {
    if (!rule) return
    setBusy("all")
    try {
      // A rule carrying a saved regex autofix needs no model round-trip, so
      // this path works with AI unconfigured.
      if (rule.autofix) {
        setProposal(buildRegexProposal(rule.autofix, violatingCells, "cached-regex"))
        return
      }
      if (!completionSettings) return
      setProposal(await requestBatchFix({
        rule, violatingCells, passingCells,
        settings: completionSettings, session: session ?? null,
      }))
    } finally {
      setBusy(null)
    }
  }, [rule, completionSettings, session])

  const applySelected = useCallback(async (selectedCellIds: Set<string>) => {
    if (!proposal || proposal.kind === "none" || !onApplyFix) return
    const chosen = proposal.previews.filter((p) => selectedCellIds.has(p.cellId))
    if (chosen.length === 0) return
    const proposalKind: ProposalKind = proposal.kind === "per-cell"
      ? "per-cell"
      : chosen.every((p) => p.source === "cached-regex") ? "cached-regex" : "batch-regex"
    setApplying(true)
    try {
      await onApplyFix(chosen, proposalKind)
      setProposal(null)
    } catch {
      // Keep the sheet open on its previews so the reviewer can retry rather
      // than lose the proposal they just read. Swallowed rather than rethrown
      // because this runs from an event handler, where a rejection would only
      // become an unhandled one.
    } finally {
      setApplying(false)
    }
  }, [proposal, onApplyFix])

  if (!rule || !project) return null

  const cellMap = new Map(cells.map((c) => [c.id, c]))
  const infractionCells = infractions.map((inf) => ({ infraction: inf, cell: cellMap.get(inf.cellId) })).filter((x) => x.cell)
  const infractionCellIds = new Set(infractions.map((i) => i.cellId))
  const passingCells = cells.filter((c) => c.status !== "empty" && !infractionCellIds.has(c.id)).slice(0, 10)

  const SeverityIcon = rule.severity === "major" ? AlertTriangle : AlertCircle
  const severityColor = rule.severity === "major" ? "text-red-500" : "text-amber-500"

  // Why a fix affordance is unavailable, so a disabled button is never a dead
  // end — the span carries the hover because a disabled button has
  // pointer-events: none and its own tooltip would never fire.
  const fixBlockedReason = !canApply
    ? t("rules.drawer.fixNotPermitted")
    : !aiReady
      ? t("rules.drawer.aiNotConfigured")
      : null
  const fixAllBlockedReason = rule.autofix && canApply ? null : fixBlockedReason
  const fixAllDisabled = fixAllBlockedReason != null || infractionCells.length === 0 || busy != null

  function onAmendRule() {
    navigate(withEditorReturn(
      `/project/${project!.id}/memory/quality?ruleId=${rule!.id}&focus=autofix`,
      editorReturnFromLocation(location.pathname, location.search, project!.id),
    ))
  }

  return (
    <RightSidebarPanel storageKey="rule" defaultWidth={320} resizeLabel="Resize rule panel">
      <div className="flex h-full w-full flex-col border-l bg-card">
      <div className="flex items-center justify-between border-b p-2">
        <div className="flex items-center gap-2">
          <SeverityIcon className={`h-4 w-4 ${severityColor}`} />
          <h3 className="text-sm font-semibold">{translateRuleName(rule, t)}</h3>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("rules.drawer.closeAriaLabel")}>
          <X />
        </Button>
      </div>

      <div className="flex items-center gap-2 border-b px-3 py-2">
        <AppTooltip content={fixAllBlockedReason ?? t("rules.drawer.tryToFixAllTooltip")}>
          <span className="inline-flex">
            <Button
              size="sm"
              disabled={fixAllDisabled}
              onClick={() => void proposeForAll(
                infractionCells.map(({ cell }) => cell!),
                passingCells,
              )}
            >
              {busy === "all"
                ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" />
                : <Wand2 className="me-1 h-3.5 w-3.5" />}
              {busy === "all" ? t("rules.drawer.proposingFix") : t("rules.surface.tryToFixAllButton")}
            </Button>
          </span>
        </AppTooltip>
        <Button variant="ghost" size="sm" onClick={onAmendRule}>{t("rules.drawer.amendRuleButton")}</Button>
      </div>

      <div className="border-b px-3 py-1 text-[10px] text-muted-foreground">
        {rule.autofix
          ? t("rules.drawer.savedAutofix", {
              pattern: rule.autofix.pattern,
              flags: rule.autofix.flags,
              replacement: rule.autofix.replacement,
            })
          : t("rules.drawer.noSavedFix")}
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-4">
        {rule.description && (
          <p className="text-xs text-muted-foreground">{translateRuleDescription(rule, t)}</p>
        )}

        <div>
          <p className="text-xs text-muted-foreground mb-1">
            {t("rules.drawer.breakingThisRule", { count: infractionCells.length })}
          </p>
          {infractionCells.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("common.none")}</p>
          ) : (
            <ul className="space-y-1">
              {infractionCells.slice(0, 20).map(({ infraction, cell }) => (
                <li key={infraction.cellId} className="flex items-start gap-1">
                  <button
                    className="flex-1 rounded border-s-2 border-red-400 bg-red-50 p-1.5 text-start text-xs hover:bg-red-100 dark:bg-red-950/20 dark:hover:bg-red-950/40"
                    aria-label={t("rules.drawer.openCellAriaLabel", { cellId: infraction.cellId })}
                    onClick={() => onNavigateToCell(infraction.cellId)}
                  >
                    <div className="truncate text-muted-foreground">{cell!.original.slice(0, 60)}...</div>
                    <div className="truncate font-medium">{cell!.translated.slice(0, 60)}...</div>
                  </button>
                  <AppTooltip content={fixBlockedReason ?? t("rules.drawer.fixCellTooltip")}>
                    <span className="inline-flex">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1"
                        disabled={fixBlockedReason != null || busy != null}
                        aria-label={t("rules.drawer.fixCellAriaLabel")}
                        onClick={() => void proposeForCell(cell!)}
                      >
                        {busy === infraction.cellId
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <Sparkles className="h-3 w-3" />}
                      </Button>
                    </span>
                  </AppTooltip>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">
            {t("rules.drawer.followingThisRule", {
              count: `${passingCells.length}${passingCells.length >= 10 ? "+" : ""}`,
            })}
          </p>
          {passingCells.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("rules.drawer.noTranslatedCellsYet")}</p>
          ) : (
            <ul className="space-y-1">
              {passingCells.map((cell) => (
                <li key={cell.id}>
                  <button
                    className="w-full rounded border-s-2 border-green-400 bg-green-50 p-1.5 text-start text-xs hover:bg-green-100 dark:bg-green-950/20 dark:hover:bg-green-950/40"
                    aria-label={t("rules.drawer.openCellAriaLabel", { cellId: cell.id })}
                    onClick={() => onNavigateToCell(cell.id)}
                  >
                    <div className="truncate text-muted-foreground">{cell.original.slice(0, 60)}...</div>
                    <div className="truncate font-medium">{cell.translated.slice(0, 60)}...</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {proposal && (
        <FixReviewPanel
          open
          rule={rule}
          proposal={proposal}
          onClose={() => { if (!applying) setProposal(null) }}
          onApply={(selected) => void applySelected(selected)}
          onAmendRule={onAmendRule}
          // AQU-186: a sweep over more than one cell is irreversible-by-default,
          // so bulk Apply stays behind the typed-confirmation gate. A single
          // surgical fix on the cell you are looking at is not a sweep.
          confirmPhrase={
            proposal.kind !== "none" && proposal.previews.length > 1 ? rule.name : undefined
          }
        />
      )}
    </div>
    </RightSidebarPanel>
  )
}
