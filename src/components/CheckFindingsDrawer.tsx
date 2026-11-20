/**
 * CheckFindingsDrawer — Phase 0.5 findings UI v0 for the deterministic
 * "Check file" pass (agentic-harness-strategy §4/§8, deterministic only).
 *
 * Session-local findings: the result lives in ProjectWorkspace state, nothing
 * is persisted or sent to a server. No apply/fix actions in this phase —
 * findings cite their evidence (cell references, rule/concept names) and a
 * cell reference click scrolls/focuses that cell in the editor. The comment
 * button opens a composer in place (CheckFindingCommentPopover), so leaving a
 * note does not cost the reviewer their place in the findings.
 *
 * AQU-1737 adds the one judgement call in the panel: approving a suspected
 * spelling. It is session-local for the same reason as the findings, and it is
 * per FORM, never per cell — a spelling card carries every cell its form
 * occurs in, so one click clears all of them. Asking the same question once
 * per cell is how a spell check stops being used.
 */

import { useState, type ComponentType, type ReactNode } from "react"
import {
  X,
  AlertTriangle,
  AlertCircle,
  BookA,
  CaseSensitive,
  ChevronRight,
  MessageSquare,
  RefreshCw,
  SpellCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { cellTextForDisplay, truncateCellText } from "@/lib/cell-text"
import { cn } from "@/lib/utils"
import { parseTimestampRange } from "@/lib/video/vtt-generator"
import { useI18n, useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { formatTime, formatCount, useFormat } from "@/lib/i18n/format"
import { translateRuleName } from "@/lib/lqa/builtin-resolver"
import { isBibleCheckInfraction } from "@/lib/bible-data/check-messages"
import { formatInfractionEvidence, formatInfractionReason } from "@/lib/rules/format-infraction"
import type { CellData } from "@/hooks/useCells"
import { approveSpelling, withoutApprovedSpellings } from "@/lib/qa/spelling"
import type {
  CapitalizationFinding,
  CheckRunResult,
  RuleFindingGroup,
  SpellingFinding,
  TermConsistencyFinding,
} from "@/lib/check/deterministic-check"
import { RightSidebarPanel } from "./RightSidebarPanel"
import { CheckFindingCommentPopover } from "./CheckFindingCommentPopover"

interface CheckFindingsDrawerProps {
  result: CheckRunResult | null
  running: boolean
  cells: CellData[]
  onClose: () => void
  /** Re-runs the open-file check without closing the drawer. */
  onRetry: () => void
  onNavigateToCell: (cellId: string) => void
  /** Opens the existing per-cell comments drawer. */
  onOpenComments?: (cellId: string) => void
  /**
   * Posts a new comment thread on a cell from the finding's own popover. Absent
   * when the viewer cannot comment; the button then opens the comments drawer,
   * which explains why.
   */
  onAddComment?: (cellId: string, text: string) => Promise<void>
}

/** A card shows this many cells before "Show N more". */
const CELLS_SHOWN = 3
/** A section with more cards than this starts with its cards folded. */
const CARDS_OPEN_LIMIT = 5

/** "32 cells · 12 rules · 8 terms" — the spec's what-was-checked summary. */
export function checkScopeSummary(result: CheckRunResult, t: TFunction, locale: string): string {
  return [
    t("common.cellCount", { count: formatCount(result.checkedCellCount, locale) }),
    t("rules.checkDrawer.scopeRules", { count: formatCount(result.checkedRuleCount, locale) }),
    t("rules.checkDrawer.scopeTerms", { count: formatCount(result.checkedTermCount, locale) }),
  ].join(" · ")
}

/** Headline for a term card: "Χριστός: 14 of 18 occurrences use "Kristo", 4 use something else". */
export function termFindingHeadline(f: TermConsistencyFinding, t: TFunction, locale: string): string {
  const used = f.renderingUsage
    .filter((u) => u.cellIds.length > 0)
    .map((u) => `"${u.rendering}" (${u.cellIds.length})`)
    .join(", ")
  const usePart =
    f.consistentCount === 0
      ? t("rules.checkDrawer.termHeadline.noneApproved", {
          total: formatCount(f.totalOccurrences, locale),
        })
      : t("rules.checkDrawer.termHeadline.someApproved", {
          consistent: formatCount(f.consistentCount, locale),
          total: formatCount(f.totalOccurrences, locale),
          used,
        })
  const flagged = f.flaggedCells.length
  return flagged > 0 && f.consistentCount > 0
    ? t("rules.checkDrawer.termHeadline.someUseSomethingElse", {
        usePart,
        flagged: formatCount(flagged, locale),
      })
    : usePart
}

function formatRunTime(iso: string, locale: string): string {
  return formatTime(iso, locale, { hour: "numeric", minute: "2-digit" })
}

/** A UUID (any version) — an internal id that must never reach the screen. */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** SUB-5: human title for a finding card. Prefer the cell's label (verse ref);
 * for subtitle cues (no label) fall back to the cue's timestamp range parsed
 * from `context`; otherwise `fallback` ("Cell 12"). Never the cell's id: a
 * reader cannot do anything with a UUID. */
export function findingCellLabel(cell: CellData | undefined, fallback: string, hint?: string): string {
  if (hint && !ID_SHAPE.test(hint)) return hint
  if (cell?.cellLabel && !ID_SHAPE.test(cell.cellLabel)) return cell.cellLabel
  const range = cell ? parseTimestampRange(cell.context) : null
  if (range) return `${fmtCueTime(range.start)}–${fmtCueTime(range.end)}`
  return fallback
}

/** Compact cue clock: mm:ss.t, hours only when nonzero. */
function fmtCueTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const ss = s.toFixed(1).padStart(4, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

/** What every card needs to draw and act on a cell reference. */
interface CellRefs {
  cellMap: Map<string, CellData>
  labelFor: (cellId: string, hint?: string) => string
  onNavigateToCell: (cellId: string) => void
  onOpenComments?: (cellId: string) => void
  onAddComment?: (cellId: string, text: string) => Promise<void>
}

interface CellRefItem {
  cellId: string
  hint?: string
  detail?: string
  /** AQU-1688: where a Bible data finding's fact comes from. */
  evidence?: string[]
}

function CellRefButton({ item, refs }: { item: CellRefItem; refs: CellRefs }) {
  const t = useT()
  const { cellId, detail, evidence } = item
  const cell = refs.cellMap.get(cellId)
  const label = refs.labelFor(cellId, item.hint)
  const { onOpenComments, onAddComment } = refs
  return (
    // min-w-0 on the flex item + button (SUB-5): without it, long unbroken
    // content (raw HTML snippets) sets the intrinsic width and the card
    // punches through the fixed-width drawer; the inner `truncate`s only work
    // once their flex ancestors are allowed to shrink.
    <li className="flex min-w-0 items-start gap-1">
      {/* The card shows what it is and is the way to it: no hover (AQU-2260). */}
      <button
        type="button"
        className="min-w-0 flex-1 rounded border-s-2 border-amber-400 bg-amber-50 p-1.5 text-start text-xs hover:bg-amber-100 dark:bg-amber-950/20 dark:hover:bg-amber-950/40"
        onClick={() => refs.onNavigateToCell(cellId)}
      >
        <div className="truncate font-medium">{label}</div>
        {detail && <div className="truncate text-muted-foreground">{detail}</div>}
        {evidence?.map((line) => (
          <div key={line} className="truncate text-muted-foreground/80">{line}</div>
        ))}
        {cell && (
          <div className="truncate text-muted-foreground">
            {truncateCellText(cellTextForDisplay(cell.translated), 60)}
          </div>
        )}
      </button>
      {onAddComment ? (
        <CheckFindingCommentPopover
          label={label}
          onAddComment={(text) => onAddComment(cellId, text)}
          onOpenThread={onOpenComments && (() => onOpenComments(cellId))}
        />
      ) : onOpenComments ? (
        <AppTooltip content={t("rules.checkDrawer.commentOnCell")}>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1"
            onClick={() => onOpenComments(cellId)}
            aria-label={t("rules.checkDrawer.commentOnCellAriaLabel", { label })}
          >
            <MessageSquare className="h-3 w-3" />
          </Button>
        </AppTooltip>
      ) : null}
    </li>
  )
}

/**
 * The shell every finding card shares: a header that folds the card, an
 * optional headline, and the flagged cells — the first few, then "Show N more",
 * so one noisy rule cannot push every other finding off the panel.
 */
function FindingCard({
  icon: Icon,
  iconClassName = "text-amber-500",
  title,
  count,
  action,
  headline,
  items,
  refs,
  defaultOpen,
}: {
  icon: ComponentType<{ className?: string }>
  iconClassName?: string
  title: string
  /** Shown on the right of the header unless `action` takes that place. */
  count: number
  action?: ReactNode
  headline?: string
  items: CellRefItem[]
  refs: CellRefs
  defaultOpen: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(defaultOpen)
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? items : items.slice(0, CELLS_SHOWN)
  const hidden = items.length - shown.length
  return (
    <div className="min-w-0 rounded-md border">
      <div className="flex min-w-0 items-center gap-1 p-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 text-start hover:bg-muted/60"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform rtl:-scale-x-100", open && "rotate-90 rtl:scale-x-100")}
          />
          <Icon className={cn("h-3.5 w-3.5 shrink-0", iconClassName)} />
          <span className="min-w-0 truncate text-xs font-semibold">{title}</span>
          {!action && (
            <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">
              {t("common.cellCount", { count })}
            </span>
          )}
        </button>
        {action}
      </div>
      {open && (
        <div className="min-w-0 px-2 pb-2">
          {headline && <p className="mb-1.5 break-words text-xs text-muted-foreground">{headline}</p>}
          <ul className="min-w-0 space-y-1">
            {/* One rule can match the same cell twice, so the id alone is not a key. */}
            {shown.map((item, i) => (
              <CellRefButton key={`${item.cellId}:${i}`} item={item} refs={refs} />
            ))}
          </ul>
          {(hidden > 0 || showAll) && items.length > CELLS_SHOWN && (
            <button
              type="button"
              className="mt-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => setShowAll((s) => !s)}
            >
              {hidden > 0
                ? t("rules.checkDrawer.showMoreCells", { count: hidden })
                : t("common.showLess")}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One kind of finding (rules, terms, …). Its header folds it; a kind with
 * nothing to report starts folded, so the panel opens on what needs work.
 * Notes about what the check let through stay inside, under the cards.
 */
function FindingSection({
  title,
  count,
  children,
  notes,
}: {
  title: string
  count: number
  children: ReactNode
  notes?: ReactNode
}) {
  const t = useT()
  const [open, setOpen] = useState(count > 0)
  return (
    <section className="min-w-0">
      <button
        type="button"
        className={cn(
          "mb-1 flex w-full min-w-0 items-center gap-1 rounded text-start text-xs hover:text-foreground",
          count > 0 ? "font-medium text-foreground" : "text-muted-foreground",
        )}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform rtl:-scale-x-100", open && "rotate-90 rtl:scale-x-100")}
        />
        <span className="min-w-0 truncate">{title}</span>
      </button>
      {open && (
        <div className="min-w-0 ps-4">
          {count === 0 ? (
            <p className="text-xs text-muted-foreground">{t("common.none")}</p>
          ) : (
            <div className="min-w-0 space-y-2">{children}</div>
          )}
          {notes}
        </div>
      )}
    </section>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 break-words text-[10px] text-muted-foreground">{children}</p>
}

export function CheckFindingsDrawer({
  result,
  running,
  cells,
  onClose,
  onRetry,
  onNavigateToCell,
  onOpenComments,
  onAddComment,
}: CheckFindingsDrawerProps) {
  const t = useT()
  const format = useFormat()
  const { locale } = useI18n()
  const cellMap = new Map(cells.map((c) => [c.id, c]))
  const cellPosition = new Map(cells.map((c, i) => [c.id, i + 1]))
  const refs: CellRefs = {
    cellMap,
    labelFor: (cellId, hint) => {
      const position = cellPosition.get(cellId)
      return findingCellLabel(
        cellMap.get(cellId),
        position !== undefined
          ? t("rules.checkDrawer.cellNumber", { number: formatCount(position, locale) })
          : t("rules.checkDrawer.unknownCell"),
        hint,
      )
    },
    onNavigateToCell,
    onOpenComments,
    onAddComment,
  }

  const flaggedTermFindings = result?.termFindings.filter((f) => f.flaggedCells.length > 0) ?? []
  const cleanTermCount = (result?.termFindings.length ?? 0) - flaggedTermFindings.length
  const ruleIssueCount = result?.ruleFindings.reduce((n, g) => n + g.infractions.length, 0) ?? 0
  const termIssueCount = flaggedTermFindings.reduce((n, f) => n + f.flaggedCells.length, 0)
  const capitalizationFindings = result?.capitalizationFindings ?? []
  const capitalizationIssueCount = capitalizationFindings.reduce((n, f) => n + f.cells.length, 0)
  const caseExceptions = result?.caseExceptions ?? []

  // AQU-1737. Held here, not in ProjectWorkspace, and deliberately NOT reset
  // when a new result arrives: a spelling the reviewer has already accepted
  // must not come back on the next run of the same check.
  const [approvedSpellings, setApprovedSpellings] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const spellingFindings = withoutApprovedSpellings(result?.spellingFindings ?? [], approvedSpellings)
  const autoApprovedSpellings = result?.approvedSpellings ?? []
  const wordlistSize = result?.wordlistSize ?? 0

  const ruleFindings = result?.ruleFindings ?? []
  const caseExceptionsNote = caseExceptions.length > 0 && (
    // AQU-1734: what the scan learned to allow, so a reviewer can see the
    // exceptions instead of trusting a silent pass.
    <Note>
      {t("rules.checkDrawer.caseExceptionsLearned", {
        forms: caseExceptions.map((e) => e.form).join(", "),
      })}
    </Note>
  )

  return (
    <RightSidebarPanel storageKey="check" defaultWidth={320} resizeLabel={t("editor.panel.resizeCheck")}>
    <div className="flex h-full min-w-0 w-full flex-col overflow-hidden border-s bg-card">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b p-2">
        {/* Wording tracks the "Check file" button and its "Close file check"
            tooltip — the drawer is that button's result surface. */}
        <h3 className="min-w-0 truncate text-sm font-semibold">{t("rules.checkDrawer.title")}</h3>
        <div className="flex shrink-0 items-center gap-0.5">
          <AppTooltip content={t("rules.checkDrawer.retryAriaLabel")}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onRetry}
              disabled={running}
              aria-label={t("rules.checkDrawer.retryAriaLabel")}
            >
              {running ? <Spinner /> : <RefreshCw />}
            </Button>
          </AppTooltip>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("rules.checkDrawer.closeAriaLabel")}
          >
            <X />
          </Button>
        </div>
      </div>

      {running ? (
        <div className="flex flex-1 items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          {t("autopilot.phase.checking")}
        </div>
      ) : !result ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          {t("rules.checkDrawer.emptyPrompt")}
        </div>
      ) : (
        <>
          <div className="shrink-0 truncate border-b px-3 py-2 text-xs text-muted-foreground">
            {t("rules.checkDrawer.checkedSummary", {
              summary: checkScopeSummary(result, t, locale),
              time: formatRunTime(result.ranAt, locale),
            })}
          </div>

          {result.totalFindingCount === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
              <p>{t("rules.checkDrawer.checkedNoIssues", { summary: checkScopeSummary(result, t, locale) })}</p>
              {/* AQU-1734: a clean result still accounts for what the
                  capitalization scan excepted — silence is never unexplained. */}
              {caseExceptions.length > 0 && (
                <p className="break-words text-[10px]">
                  {t("rules.checkDrawer.caseExceptionsLearned", {
                    forms: caseExceptions.map((e) => e.form).join(", "),
                  })}
                </p>
              )}
            </div>
          ) : (
            <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-auto p-3">
              <FindingSection
                title={t("rules.checkDrawer.ruleViolations", { count: ruleIssueCount })}
                count={ruleFindings.length}
              >
                {ruleFindings.map((group: RuleFindingGroup) => (
                  <FindingCard
                    key={group.rule.id}
                    icon={group.rule.severity === "major" ? AlertTriangle : AlertCircle}
                    iconClassName={group.rule.severity === "major" ? "text-red-500" : "text-amber-500"}
                    // The user's OWN rule name is content and stays as written; a
                    // built-in check's name is app chrome, resolved by translateRuleName.
                    title={translateRuleName(group.rule, t)}
                    count={group.infractions.length}
                    items={group.infractions.map((inf) => ({
                      cellId: inf.cellId,
                      // AQU-1688: a Bible data finding explains itself; its marks alone say little.
                      detail: isBibleCheckInfraction(inf)
                        ? formatInfractionReason(inf, t)
                        : inf.spans[0]?.matchedText
                          ? t("rules.checkDrawer.matchedDetail", { text: inf.spans[0].matchedText })
                          : undefined,
                      evidence: formatInfractionEvidence(inf, t, format),
                    }))}
                    refs={refs}
                    defaultOpen={ruleFindings.length <= CARDS_OPEN_LIMIT}
                  />
                ))}
              </FindingSection>

              <FindingSection
                title={t("rules.checkDrawer.termConsistency", { count: termIssueCount })}
                count={flaggedTermFindings.length}
                notes={cleanTermCount > 0 && (
                  <Note>{t("rules.checkDrawer.otherTermsClean", { count: cleanTermCount })}</Note>
                )}
              >
                {flaggedTermFindings.map((finding: TermConsistencyFinding) => (
                  <FindingCard
                    key={finding.conceptId}
                    icon={BookA}
                    // finding.sourceTerm is content (the term itself) — never keyed.
                    title={finding.sourceTerm}
                    count={finding.flaggedCells.length}
                    headline={termFindingHeadline(finding, t, locale)}
                    items={finding.flaggedCells.map((fc) => ({ cellId: fc.cellId, hint: fc.cellLabel }))}
                    refs={refs}
                    defaultOpen={flaggedTermFindings.length <= CARDS_OPEN_LIMIT}
                  />
                ))}
              </FindingSection>

              <FindingSection
                title={t("rules.checkDrawer.capitalization", { count: capitalizationIssueCount })}
                count={capitalizationFindings.length}
                notes={caseExceptionsNote}
              >
                {capitalizationFindings.map((finding: CapitalizationFinding) => (
                  // AQU-1734: a mixed-case card is titled by the offending word
                  // form (raw cell content, never translated); the heading card
                  // carries a localized title because it has no single form to name.
                  <FindingCard
                    key={`${finding.code}:${finding.form}`}
                    icon={CaseSensitive}
                    title={finding.code === "mixed-case" ? finding.form : t("rules.checkDrawer.headingStartsLowercase")}
                    count={finding.cells.length}
                    headline={finding.code === "mixed-case"
                      ? t("rules.checkDrawer.mixedCaseHeadline", { count: finding.cells.length })
                      : undefined}
                    items={finding.cells.map((fc) => ({ cellId: fc.cellId, hint: fc.cellLabel }))}
                    refs={refs}
                    defaultOpen={capitalizationFindings.length <= CARDS_OPEN_LIMIT}
                  />
                ))}
              </FindingSection>

              {/* AQU-1737: suspected misspellings, from the project's own wordlist. */}
              <FindingSection
                title={t("rules.checkDrawer.spelling", { count: spellingFindings.length })}
                count={spellingFindings.length}
                notes={
                  <>
                    {approvedSpellings.size > 0 && (
                      <Note>{t("rules.checkDrawer.spellingApproved", { count: approvedSpellings.size })}</Note>
                    )}
                    {/* Same contract as the case exceptions: a form let through
                        on frequency alone is named, not silently passed. */}
                    {autoApprovedSpellings.length > 0 && (
                      <Note>
                        {t("rules.checkDrawer.spellingAutoApproved", {
                          forms: autoApprovedSpellings.map((e) => e.form).join(", "),
                        })}
                      </Note>
                    )}
                    {wordlistSize > 0 && (
                      <Note>{t("rules.checkDrawer.wordlistSize", { count: wordlistSize })}</Note>
                    )}
                  </>
                }
              >
                {spellingFindings.map((finding: SpellingFinding) => (
                  // AQU-1737: titled by the suspected form (raw cell content,
                  // never translated), with the spelling the project usually
                  // writes as the suggestion, and one Approve that clears every
                  // occurrence.
                  <FindingCard
                    key={finding.form}
                    icon={SpellCheck}
                    title={finding.form}
                    count={finding.cells.length}
                    action={
                      <AppTooltip
                        content={t("rules.checkDrawer.approveSpellingAriaLabel", { form: finding.form })}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 shrink-0 px-1.5 text-[10px]"
                          onClick={() => setApprovedSpellings((prev) => approveSpelling(prev, finding.form))}
                          aria-label={t("rules.checkDrawer.approveSpellingAriaLabel", { form: finding.form })}
                        >
                          {t("rules.checkDrawer.approveSpelling")}
                        </Button>
                      </AppTooltip>
                    }
                    headline={t(
                      finding.reason === "sound-alike"
                        ? "rules.checkDrawer.spellingSoundsLike"
                        : "rules.checkDrawer.spellingCloseTo",
                      { suggestion: finding.suggestion, suggestionCount: finding.suggestionOccurrences },
                    )}
                    items={finding.cells.map((fc) => ({ cellId: fc.cellId, hint: fc.cellLabel }))}
                    refs={refs}
                    defaultOpen={spellingFindings.length <= CARDS_OPEN_LIMIT}
                  />
                ))}
              </FindingSection>
            </div>
          )}
        </>
      )}
    </div>
    </RightSidebarPanel>
  )
}
