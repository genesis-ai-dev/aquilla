/**
 * TerminologyViolationsInbox — by-concept terminology violations.
 *
 * Reuses the SHARED rule-engine: it compiles the project's active concepts to
 * TranslationRules (the same `compileConceptsToRules` path useRules uses) and
 * runs `checkRules` over the loaded project cells. The resulting infractions are
 * filtered to the stable `term:{conceptId}:` id scheme and grouped one-row-per-
 * concept by the pure `groupTerminologyInfractions` helper. No parallel engine.
 *
 * Evaluation is gated by the caller behind the active "Violations" tab (lazy),
 * mirroring the candidate-tab pattern, so the (super-linear-ish, regex-per-cell)
 * scan only runs when the user is looking at this surface.
 *
 * AQU-1888: and when it does run, it runs through the shared *incremental*
 * scan (`useProjectInfractions`), never in a render-time memo. See the comment
 * on that call below.
 */
import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, FileText, ShieldAlert } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { CellData } from "@/hooks/useCells"
import type { TerminologyViolationRow } from "@/lib/terminology/project-scan"
import type { Concept, TermMatchingSettings } from "@/lib/terminology/types"
import { renderingStatusLabelKey } from "@/lib/terminology/types"
import { compileConceptsToRules } from "@/lib/terminology/compile"
import { useProjectInfractions } from "@/hooks/useProjectInfractions"
import {
  groupTerminologyInfractions,
  violationCellRef,
  type ConceptViolationGroup,
} from "@/lib/terminology/violations-inbox"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

/**
 * Stable empties. The incremental scan re-plans on every new array identity,
 * so the no-op (server `rows`) path must hand it the same arrays every render.
 */
const NO_CELLS: CellData[] = []
const NO_RULES: TranslationRule[] = []

interface Props {
  concepts: Concept[]
  /**
   * Loaded project cells. Used when the caller already holds them. The
   * glossary passes `rows` instead, so opening Violations does not download
   * every verse.
   */
  cells?: CellData[]
  /** Infringements already found by the server scan. */
  rows?: TerminologyViolationRow[]
  /** The scan stopped early or the response omitted further infringements. */
  truncated?: boolean
  /** Jump back to the editor focused on the offending cell, when supported. */
  onJumpToCell?: (cell: { cellId: string; fileId: string }) => void
  /** AQU-1271: project-level source-matching defaults, from `project.termMatching`. */
  termMatching?: TermMatchingSettings
  /** AQU-663: project files, so an infringing-cell row can name the file it is
   *  in instead of exposing ids. Optional — rows degrade to no file affordance. */
  files?: Array<{ id: string; name: string }>
}

export function TerminologyViolationsInbox({
  concepts,
  cells = NO_CELLS,
  rows,
  truncated = false,
  onJumpToCell,
  termMatching,
  files,
}: Props) {
  const t = useT()
  // AQU-1888: this scan used to run right here, in a render-time memo —
  // `compileConceptsToRules` and then `checkRules` over every loaded cell,
  // synchronously during render, and again on every republish of `cells` (the
  // outbox moves, `useProjectCells` hands down a new array, the memo is
  // invalidated even though at most one cell changed). On a full Bible with an
  // active termbase that is the same freeze AQU-1864 fixed on the rules page,
  // on a corpus of the same size.
  //
  // The work now goes through the shared incremental scan: sliced across
  // frames under a time budget, cached per cell, so concept groups fill in
  // progressively and a single cell edit re-evaluates a single cell. Grouping
  // by concept is this surface's own job (the rules pane counts per rule), so
  // only the scan is shared — `groupTerminologyInfractions` still runs here.
  //
  // A `rows` list is already the result of this scan on the server, so that
  // path compiles nothing and scans nothing.
  const fromServer = rows !== undefined
  const termRules = useMemo<TranslationRule[]>(
    () =>
      fromServer
        ? NO_RULES
        : // `checkRules` dropped disabled rules for us; `checkRulesForCell`,
          // which the scan calls, does not.
          compileConceptsToRules(concepts, termMatching).filter((rule) => rule.enabled),
    [fromServer, concepts, termMatching],
  )
  const { infractions, scanning } = useProjectInfractions(
    fromServer ? NO_CELLS : cells,
    termRules,
  )

  const groups = useMemo<ConceptViolationGroup[]>(() => {
    if (rows) return groupsFromRows(rows)
    return groupTerminologyInfractions([...infractions.values()].flat(), concepts)
  }, [rows, infractions, concepts])

  const cellById = useMemo(() => {
    const m = new Map<string, CellData>()
    if (rows) {
      for (const row of rows) {
        m.set(row.cellId, {
          id: row.cellId,
          fileId: row.fileId,
          original: row.original,
          translated: row.translated,
          context: row.context,
        } as CellData)
      }
      return m
    }
    for (const c of cells) m.set(c.id, c)
    return m
  }, [cells, rows])

  const fileNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of files ?? []) m.set(f.id, f.name)
    return m
  }, [files])

  const totalViolations = useMemo(
    () => groups.reduce((s, g) => s + g.count, 0),
    [groups],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          {t("terminology.violations.title")}
          {groups.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground">
              <RichMessage
                k="terminology.violations.summary"
                count={groups.length}
                values={{ total: totalViolations, count: groups.length }}
              />
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("terminology.violations.description")}</p>
        {truncated && (
          <p className="text-xs text-muted-foreground">{t("terminology.violations.truncated")}</p>
        )}
        {/* AQU-1888: the sliced scan publishes a subset of the final groups, so
            say so rather than letting a partial list read as the whole answer.
            The string is the one the server-`rows` caller already shows while
            its scan loads, so both halves of this surface say the same thing. */}
        {scanning && (
          <p
            role="status"
            data-testid="terminology-violations-scanning"
            className="text-xs text-muted-foreground"
          >
            {t("terminology.editor.checkingTerminology")}
          </p>
        )}

        {groups.length === 0 ? (
          // A still-running scan has found nothing *yet*; claiming the project
          // is clean would be a lie until it settles.
          scanning ? null : (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
              <ShieldAlert className="h-8 w-8 opacity-40" />
              <p className="text-sm">{t("terminology.violations.emptyTitle")}</p>
              <p className="text-xs">
                {t("terminology.violations.emptyDescriptionPre")}{" "}
                <span className="font-medium">{t("terminology.common.statusApproved")}</span>{" "}
                {t("terminology.violations.emptyDescriptionPost")}
              </p>
            </div>
          )
        ) : (
          <ul className="divide-y">
            {groups.map((g) => (
              <ConceptViolationRow
                key={g.conceptId}
                group={g}
                cellById={cellById}
                fileNameById={fileNameById}
                onJumpToCell={onJumpToCell}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function ConceptViolationRow({
  group,
  cellById,
  fileNameById,
  onJumpToCell,
}: {
  group: ConceptViolationGroup
  cellById: Map<string, CellData>
  fileNameById: Map<string, string>
  onJumpToCell?: (cell: { cellId: string; fileId: string }) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)

  return (
    <li className="py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-start"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate text-sm font-medium">
          {group.sourceTerm}
        </span>
        <span className="shrink-0 rounded bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
          {group.count}
        </span>
        <span className="hidden shrink-0 gap-1.5 text-[10px] sm:flex">
          {group.missingApprovedCount > 0 && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              {t("terminology.violations.missingCount", { count: group.missingApprovedCount })}
            </span>
          )}
          {group.forbiddenPresentCount > 0 && (
            <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
              {t("terminology.violations.forbiddenCount", { count: group.forbiddenPresentCount })}
            </span>
          )}
        </span>
      </button>

      {open && (
        <ul className="mt-2 space-y-1 ps-6">
          {group.infractions.map((inf, i) => {
            const cell = cellById.get(inf.cellId)
            // AQU-663: the row names the cell by its ref/tag, never by the raw
            // internal id — that id told the reviewer nothing about which verse
            // was in breach. `violationCellRef` returns null when the cell has
            // no nameable ref, and the placeholder below is localized.
            const label = violationCellRef(cell) ?? t("terminology.violations.unnamedCell")
            const fileName = fileNameById.get(inf.fileId)
            const fileTitle = fileName
              ? t("terminology.violations.inFile", { file: fileName })
              : null
            const preview = cell?.translated?.trim() || cell?.original?.trim() || ""
            return (
              <li
                key={`${inf.cellId}-${inf.ruleId}-${i}`}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
              >
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                    inf.kind === "forbidden-present"
                      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
                  )}
                >
                  {inf.kind === "forbidden-present"
                    ? t(renderingStatusLabelKey("forbidden"))
                    : t("terminology.violations.kindMissing")}
                </span>
                {onJumpToCell ? (
                  <button
                    type="button"
                    className="shrink-0 font-medium text-primary hover:underline"
                    onClick={() =>
                      onJumpToCell({ cellId: inf.cellId, fileId: inf.fileId })
                    }
                  >
                    {label}
                  </button>
                ) : (
                  <span className="shrink-0 font-medium">{label}</span>
                )}
                {fileTitle && (
                  <span
                    className="flex shrink-0 items-center gap-1 text-muted-foreground"
                    title={fileTitle}
                  >
                    <FileText className="h-3 w-3" aria-hidden="true" />
                    <span className="sr-only">{fileTitle}</span>
                    <span className="hidden max-w-[10rem] truncate sm:inline">{fileName}</span>
                  </span>
                )}
                {preview && (
                  <span className="truncate text-muted-foreground">{preview}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

function groupsFromRows(rows: TerminologyViolationRow[]): ConceptViolationGroup[] {
  const byConcept = new Map<string, ConceptViolationGroup>()
  for (const row of rows) {
    let group = byConcept.get(row.conceptId)
    if (!group) {
      group = {
        conceptId: row.conceptId,
        sourceTerm: row.sourceTerm,
        count: 0,
        missingApprovedCount: 0,
        forbiddenPresentCount: 0,
        infractions: [],
      }
      byConcept.set(row.conceptId, group)
    }
    group.count += 1
    if (row.kind === "missing-approved") group.missingApprovedCount += 1
    else group.forbiddenPresentCount += 1
    const infraction: RuleInfraction & { kind: ConceptViolationGroup["infractions"][number]["kind"] } = {
      ruleId:
        row.kind === "missing-approved"
          ? `term:${row.conceptId}:approved`
          : `term:${row.conceptId}:forbidden:scan`,
      cellId: row.cellId,
      fileId: row.fileId,
      reason: row.kind === "forbidden-present" ? "target-forbids" : "source-requires-target",
      spans: [],
      kind: row.kind,
    }
    group.infractions.push(infraction)
  }
  return [...byConcept.values()].sort(
    (a, b) => b.count - a.count || a.sourceTerm.localeCompare(b.sourceTerm),
  )
}
