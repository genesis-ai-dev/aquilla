/**
 * CheckFindingsDrawer — Phase 0.5 findings UI v0 for the deterministic
 * "Check file" pass (agentic-harness-strategy §4/§8, deterministic only).
 *
 * Session-local findings: the result lives in ProjectWorkspace state, nothing
 * is persisted or sent to a server. No apply/fix actions in this phase —
 * findings cite their evidence (cell references, rule/concept names) and a
 * cell reference click scrolls/focuses that cell in the editor. The comment
 * affordance reuses the existing CommentsDrawer via onOpenComments.
 */

import { X, AlertTriangle, AlertCircle, BookA, MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { cellTextForDisplay, truncateCellText } from "@/lib/cell-text"
import { parseTimestampRange } from "@/lib/video/vtt-generator"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatTime } from "@/lib/i18n/format"
import type { CellData } from "@/hooks/useCells"
import type {
  CheckRunResult,
  RuleFindingGroup,
  TermConsistencyFinding,
} from "@/lib/check/deterministic-check"

interface CheckFindingsDrawerProps {
  result: CheckRunResult | null
  running: boolean
  cells: CellData[]
  onClose: () => void
  onNavigateToCell: (cellId: string) => void
  /** Opens the existing per-cell comments drawer. */
  onOpenComments?: (cellId: string) => void
}

/** "32 cells · 12 rules · 8 terms" — the spec's what-was-checked summary. */
export function checkScopeSummary(result: CheckRunResult): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
  return [
    plural(result.checkedCellCount, "cell"),
    plural(result.checkedRuleCount, "rule"),
    plural(result.checkedTermCount, "term"),
  ].join(" · ")
}

/** Headline for a term card: "Χριστός: 14 of 18 occurrences use "Kristo", 4 use something else". */
export function termFindingHeadline(f: TermConsistencyFinding): string {
  const used = f.renderingUsage
    .filter((u) => u.cellIds.length > 0)
    .map((u) => `"${u.rendering}" (${u.cellIds.length})`)
    .join(", ")
  const usePart =
    f.consistentCount === 0
      ? `none of ${f.totalOccurrences} occurrence${f.totalOccurrences === 1 ? "" : "s"} use an approved rendering`
      : `${f.consistentCount} of ${f.totalOccurrences} occurrences use ${used}`
  const flagged = f.flaggedCells.length
  return flagged > 0 && f.consistentCount > 0
    ? `${usePart}, ${flagged} use something else`
    : usePart
}

function formatRunTime(iso: string, locale: string): string {
  return formatTime(iso, locale, { hour: "numeric", minute: "2-digit" })
}

/** SUB-5: human title for a finding card. Prefer the cell's label (verse ref);
 * for subtitle cues (no label) fall back to the cue's timestamp range parsed
 * from `context` — never show a raw cell UUID unless the cell is unknown. */
export function findingCellLabel(cell: CellData | undefined, cellId: string): string {
  if (cell?.cellLabel) return cell.cellLabel
  const range = cell ? parseTimestampRange(cell.context) : null
  if (range) return `${fmtCueTime(range.start)}–${fmtCueTime(range.end)}`
  return cellId
}

/** Compact cue clock: mm:ss.t, hours only when nonzero. */
function fmtCueTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const ss = s.toFixed(1).padStart(4, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

interface CellRefButtonProps {
  cellId: string
  label: string
  cell?: CellData
  onNavigateToCell: (cellId: string) => void
  onOpenComments?: (cellId: string) => void
  detail?: string
}

function CellRefButton({ cellId, label, cell, onNavigateToCell, onOpenComments, detail }: CellRefButtonProps) {
  return (
    // min-w-0 on the flex item + button (SUB-5): without it, long unbroken
    // content (raw HTML snippets, UUIDs) sets the intrinsic width and the card
    // punches through the fixed-width drawer; the inner `truncate`s only work
    // once their flex ancestors are allowed to shrink.
    <li className="flex min-w-0 items-start gap-1">
      <AppTooltip content="Go to cell">
        <button
          type="button"
          className="min-w-0 flex-1 rounded border-l-2 border-amber-400 bg-amber-50 p-1.5 text-left text-xs hover:bg-amber-100 dark:bg-amber-950/20 dark:hover:bg-amber-950/40"
          onClick={() => onNavigateToCell(cellId)}
        >
        <div className="truncate font-medium">{label}</div>
        {detail && <div className="truncate text-muted-foreground">{detail}</div>}
        {cell && (
          <div className="truncate text-muted-foreground">
            {truncateCellText(cellTextForDisplay(cell.translated), 60)}
          </div>
        )}
      </button>
      </AppTooltip>
      {onOpenComments && (
        <AppTooltip content="Comment on this cell">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1"
            onClick={() => onOpenComments(cellId)}
            aria-label={`Comment on ${label}`}
          >
            <MessageSquare className="h-3 w-3" />
          </Button>
        </AppTooltip>
      )}
    </li>
  )
}

function RuleFindingCard({
  group,
  cellMap,
  onNavigateToCell,
  onOpenComments,
}: {
  group: RuleFindingGroup
  cellMap: Map<string, CellData>
  onNavigateToCell: (cellId: string) => void
  onOpenComments?: (cellId: string) => void
}) {
  const SeverityIcon = group.rule.severity === "major" ? AlertTriangle : AlertCircle
  const severityColor = group.rule.severity === "major" ? "text-red-500" : "text-amber-500"
  return (
    <div className="min-w-0 rounded-md border p-2">
      <div className="mb-1 flex min-w-0 items-center gap-1.5">
        <SeverityIcon className={`h-3.5 w-3.5 shrink-0 ${severityColor}`} />
        <span className="min-w-0 truncate text-xs font-semibold">{group.rule.name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {group.infractions.length} cell{group.infractions.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="min-w-0 space-y-1">
        {group.infractions.map((inf) => {
          const cell = cellMap.get(inf.cellId)
          return (
            <CellRefButton
              key={`${inf.ruleId}:${inf.cellId}`}
              cellId={inf.cellId}
              label={findingCellLabel(cell, inf.cellId)}
              cell={cell}
              detail={inf.spans[0]?.matchedText ? `matched "${inf.spans[0].matchedText}"` : undefined}
              onNavigateToCell={onNavigateToCell}
              onOpenComments={onOpenComments}
            />
          )
        })}
      </ul>
    </div>
  )
}

function TermFindingCard({
  finding,
  cellMap,
  onNavigateToCell,
  onOpenComments,
}: {
  finding: TermConsistencyFinding
  cellMap: Map<string, CellData>
  onNavigateToCell: (cellId: string) => void
  onOpenComments?: (cellId: string) => void
}) {
  return (
    <div className="min-w-0 rounded-md border p-2">
      <div className="mb-1 flex min-w-0 items-center gap-1.5">
        <BookA className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="min-w-0 truncate text-xs font-semibold">{finding.sourceTerm}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {finding.flaggedCells.length} cell{finding.flaggedCells.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="mb-1.5 break-words text-xs text-muted-foreground">{termFindingHeadline(finding)}</p>
      <ul className="min-w-0 space-y-1">
        {finding.flaggedCells.map((fc) => (
          <CellRefButton
            key={fc.cellId}
            cellId={fc.cellId}
            label={fc.cellLabel ?? findingCellLabel(cellMap.get(fc.cellId), fc.cellId)}
            cell={cellMap.get(fc.cellId)}
            onNavigateToCell={onNavigateToCell}
            onOpenComments={onOpenComments}
          />
        ))}
      </ul>
    </div>
  )
}

export function CheckFindingsDrawer({
  result,
  running,
  cells,
  onClose,
  onNavigateToCell,
  onOpenComments,
}: CheckFindingsDrawerProps) {
  const { locale } = useI18n()
  const cellMap = new Map(cells.map((c) => [c.id, c]))

  const flaggedTermFindings = result?.termFindings.filter((f) => f.flaggedCells.length > 0) ?? []
  const cleanTermCount = (result?.termFindings.length ?? 0) - flaggedTermFindings.length
  const ruleIssueCount = result?.ruleFindings.reduce((n, g) => n + g.infractions.length, 0) ?? 0
  const termIssueCount = flaggedTermFindings.reduce((n, f) => n + f.flaggedCells.length, 0)

  return (
    <div className="flex h-full min-w-0 max-w-80 shrink basis-80 flex-col overflow-hidden border-l bg-card">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b p-2">
        {/* Wording tracks the "Check file" button and its "Close file check"
            tooltip — the drawer is that button's result surface. */}
        <h3 className="min-w-0 truncate text-sm font-semibold">File check</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={onClose}
          aria-label="Close file check"
        >
          <X />
        </Button>
      </div>

      {running ? (
        <div className="flex flex-1 items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Checking…
        </div>
      ) : !result ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          Run a check to see results for the open file.
        </div>
      ) : (
        <>
          <div className="shrink-0 truncate border-b px-3 py-2 text-xs text-muted-foreground">
            Checked {checkScopeSummary(result)} · {formatRunTime(result.ranAt, locale)}
          </div>

          {result.totalFindingCount === 0 ? (
            <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
              Checked {checkScopeSummary(result)} — no issues found.
            </div>
          ) : (
            <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-auto p-3">
              <div className="min-w-0">
                <p className="mb-1 text-xs text-muted-foreground">
                  Rule violations ({ruleIssueCount})
                </p>
                {result.ruleFindings.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None</p>
                ) : (
                  <div className="min-w-0 space-y-2">
                    {result.ruleFindings.map((group) => (
                      <RuleFindingCard
                        key={group.rule.id}
                        group={group}
                        cellMap={cellMap}
                        onNavigateToCell={onNavigateToCell}
                        onOpenComments={onOpenComments}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="min-w-0">
                <p className="mb-1 text-xs text-muted-foreground">
                  Term consistency ({termIssueCount})
                </p>
                {flaggedTermFindings.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None</p>
                ) : (
                  <div className="min-w-0 space-y-2">
                    {flaggedTermFindings.map((finding) => (
                      <TermFindingCard
                        key={finding.conceptId}
                        finding={finding}
                        cellMap={cellMap}
                        onNavigateToCell={onNavigateToCell}
                        onOpenComments={onOpenComments}
                      />
                    ))}
                  </div>
                )}
                {cleanTermCount > 0 && (
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    {cleanTermCount} other term{cleanTermCount === 1 ? "" : "s"} checked with no issues.
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
