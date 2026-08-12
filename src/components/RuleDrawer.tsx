import { useNavigate } from "react-router-dom"
import { X, AlertTriangle, AlertCircle, Sparkles, Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import type { TranslationRule, RuleInfraction, ProjectRecord } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { useT } from "@/lib/i18n/I18nProvider"
import { translateRuleName, translateRuleDescription } from "@/lib/lqa/builtin-resolver"

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
}

export function RuleDrawer({
  rule, infractions, cells, onClose, onNavigateToCell,
  project,
}: RuleDrawerProps) {
  const t = useT()
  const navigate = useNavigate()
  // Phase 2c-gamma: autofix applied via Y.Doc edits; the writeback path is
  // gone. The "Try to fix" buttons render disabled until the event-grammar
  // equivalent lands.

  if (!rule || !project) return null

  const cellMap = new Map(cells.map((c) => [c.id, c]))
  const infractionCells = infractions.map((inf) => ({ infraction: inf, cell: cellMap.get(inf.cellId) })).filter((x) => x.cell)
  const infractionCellIds = new Set(infractions.map((i) => i.cellId))
  const passingCells = cells.filter((c) => c.status !== "empty" && !infractionCellIds.has(c.id)).slice(0, 10)

  const SeverityIcon = rule.severity === "major" ? AlertTriangle : AlertCircle
  const severityColor = rule.severity === "major" ? "text-red-500" : "text-amber-500"

  function onAmendRule() {
    navigate(`/project/${project!.id}/rules?ruleId=${rule!.id}&focus=autofix`)
  }

  return (
    <div className="flex h-full w-80 flex-col border-s bg-card">
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
        {/* The span carries the hover: a disabled button has
            pointer-events: none, so a tooltip on the button itself never fires
            and the reason it is disabled stays unreachable. */}
        <AppTooltip content={t("rules.drawer.autofixUnavailable")}>
          <span className="inline-flex">
            <Button size="sm" disabled>
              <Wand2 className="me-1 h-3.5 w-3.5" />
              {t("rules.surface.tryToFixAllButton")}
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
                    onClick={() => onNavigateToCell(infraction.cellId)}
                  >
                    <div className="truncate text-muted-foreground">{cell!.original.slice(0, 60)}...</div>
                    <div className="truncate font-medium">{cell!.translated.slice(0, 60)}...</div>
                  </button>
                  <AppTooltip content={t("rules.drawer.autofixUnavailable")}>
                    <span className="inline-flex">
                      <Button variant="ghost" size="sm" className="h-6 px-1" disabled aria-label={t("rules.drawer.autofixUnavailableAriaLabel")}>
                        <Sparkles className="h-3 w-3" />
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

    </div>
  )
}
