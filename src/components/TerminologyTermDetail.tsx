/**
 * TerminologyTermDetail — per-concept drill-down view.
 *
 * Shows every cell occurrence of the selected concept, the current target
 * translation, the enforcement verdict (enforced / infringed / n/a), and a
 * lightweight inline target editor for contributor+ users.
 *
 * Deliberately minimal: no rail, no audio, no validation UI.  The commit
 * path mirrors EditorTable: emitTargetCellCommit → outbox → server projection.
 */

import { useMemo, useCallback, useState } from "react"
import { X, CheckCircle2, AlertCircle, Minus, SquareArrowOutUpRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { Concept, TermRendering } from "@/lib/terminology/types"
import { renderingStatusLabelKey } from "@/lib/terminology/types"
import type { CellData } from "@/hooks/useCells"
import { TranslatedEditor } from "@/components/TranslatedEditor"
import type { TranslatedEditorCommit } from "@/components/TranslatedEditor"
import { emitTargetCellCommit } from "@/lib/sync/events-emit"
import { EquivalentsPanel } from "@/components/EquivalentsPanel"
import { predictEquivalents } from "@/lib/terminology/equivalents"
import { matchesTerm } from "@/lib/terminology/match"
import { useT } from "@/lib/i18n/I18nProvider"
import { RichMessage } from "@/lib/i18n/RichMessage"

// ─── Status label helper ──────────────────────────────────────────────────────

/**
 * AQU-1006 follow-up: the status order a click cycles through.
 *
 * preferred → admitted → forbidden → preferred. Deliberately a cycle rather
 * than a dropdown: there are exactly three values, they are mutually
 * exclusive, and the chip is already the thing you want to point at. The
 * label always states the CURRENT status, so nothing depends on the user
 * knowing the order.
 */
const RENDERING_STATUS_CYCLE: Record<TermRendering["status"], TermRendering["status"]> = {
  preferred: "admitted",
  admitted: "forbidden",
  forbidden: "preferred",
}

function RenderingChip({
  rendering,
  onCycleStatus,
  onRemove,
}: {
  rendering: TermRendering
  /** Present only when the user may edit this concept's renderings. */
  onCycleStatus?: () => void
  onRemove?: () => void
}) {
  const t = useT()
  const chipClass = cn(
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
    rendering.status === "preferred" &&
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
    rendering.status === "admitted" && "bg-muted text-muted-foreground",
    rendering.status === "forbidden" &&
      "bg-red-100 text-red-700 line-through dark:bg-red-950 dark:text-red-400",
  )
  const editable = Boolean(onCycleStatus || onRemove)
  return (
    <span className={cn(chipClass, editable && "pr-0.5")}>
      {onCycleStatus ? (
        <button
          type="button"
          onClick={onCycleStatus}
          className="inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={t("terminology.termDetail.cycleStatusTitle")}
          aria-label={t("terminology.termDetail.cycleStatusAria", {
            rendering: rendering.rendering,
            status: t(renderingStatusLabelKey(rendering.status)),
          })}
        >
          {rendering.rendering}
          <span className="opacity-60">·{t(renderingStatusLabelKey(rendering.status))}</span>
        </button>
      ) : (
        <>
          {rendering.rendering}
          <span className="opacity-60">·{t(renderingStatusLabelKey(rendering.status))}</span>
        </>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 rounded-sm p-0.5 opacity-60 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring outline-none"
          aria-label={t("terminology.termDetail.removeRenderingAria", { rendering: rendering.rendering })}
        >
          <X className="size-2.5" aria-hidden />
        </button>
      )}
    </span>
  )
}

// ─── Verdict derivation (mirrors evaluateCell in stats.ts) ───────────────────

type Verdict = "enforced" | "infringed" | "na"

function deriveVerdict(concept: Concept, original: string, translated: string): Verdict {
  // Wildcard-aware match (grac* matches grace/graced/gracia) via shared matcher.
  if (!matchesTerm(original, concept.sourceTerm, { caseSensitive: concept.caseSensitive })) return "na"

  const approved = concept.renderings.filter(
    (r) => r.status === "preferred" || r.status === "admitted",
  )
  const forbidden = concept.renderings.filter((r) => r.status === "forbidden")

  if (forbidden.some((f) => matchesTerm(translated, f.rendering))) return "infringed"
  if (approved.length > 0) {
    return approved.some((a) => matchesTerm(translated, a.rendering))
      ? "enforced"
      : "infringed"
  }
  return "enforced"
}

// ─── Verdict chip ─────────────────────────────────────────────────────────────

function VerdictChip({ verdict }: { verdict: Verdict }) {
  const t = useT()
  if (verdict === "na") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
        <Minus className="h-3 w-3" />
        {t("terminology.termDetail.verdictNa")}
      </span>
    )
  }
  if (verdict === "enforced") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        {t("terminology.termDetail.verdictEnforced")}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-destructive">
      <AlertCircle className="h-3 w-3" />
      {t("terminology.termDetail.verdictInfringed")}
    </span>
  )
}

// ─── Occurrence row ───────────────────────────────────────────────────────────

interface OccurrenceRowProps {
  cell: CellData
  concept: Concept
  /** Current translated text — may be optimistically updated. */
  translated: string
  canEdit: boolean
  projectId: string
  username: string
  onOptimisticEdit: (cellId: string, patch: { value: string; valueHtml?: string }) => void
  onCellCommitted: () => void
  onJumpToCell?: (cell: { cellId: string; fileId: string }) => void
}

function OccurrenceRow({
  cell,
  concept,
  translated,
  canEdit,
  projectId,
  username,
  onOptimisticEdit,
  onCellCommitted,
  onJumpToCell,
}: OccurrenceRowProps) {
  const t = useT()
  const verdict = deriveVerdict(concept, cell.original, translated)
  const [editing, setEditing] = useState(false)

  const handleCommit = useCallback(
    ({ value, valueHtml }: TranslatedEditorCommit) => {
      onOptimisticEdit(cell.id, { value, valueHtml })
      void emitTargetCellCommit({
        projectId,
        fileId: cell.fileId,
        cellId: cell.id,
        parentId: cell.targetEventId ?? cell.sourceEventId ?? null,
        sourceEventId: cell.sourceEventId ?? null,
        value,
        valueHtml,
        author: username,
      })
        .then(() => onCellCommitted())
        .catch((err: unknown) => {
          console.warn("[TerminologyTermDetail] commit failed:", err)
        })
    },
    [
      cell.id,
      cell.fileId,
      cell.targetEventId,
      cell.sourceEventId,
      projectId,
      username,
      onOptimisticEdit,
      onCellCommitted,
    ],
  )

  return (
    <li
      className={cn(
        "flex flex-col gap-2 border-b py-3 last:border-0 sm:flex-row sm:items-start sm:gap-4",
        verdict === "infringed" && "bg-destructive/5 -mx-2 px-2 rounded",
      )}
    >
      {/* Cell ref */}
      <span className="w-24 shrink-0 font-mono text-[11px] text-muted-foreground pt-0.5">
        {cell.context || cell.group || cell.id.slice(0, 8)}
      </span>

      {/* Source snippet */}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
          {cell.original}
        </p>
      </div>

      {/* Verdict */}
      <div className="w-20 shrink-0">
        <VerdictChip verdict={verdict} />
      </div>

      {/* Target — inline editor when editing, plain text when not */}
      <div className="flex-1 min-w-0">
        {editing && canEdit ? (
          <TranslatedEditor
            cellId={cell.id}
            initialHtml={cell.translatedHtml}
            initialPlain={translated}
            onCommit={handleCommit}
            onBlur={() => setEditing(false)}
            editable={true}
            className="min-h-[2rem] rounded border px-2 py-1 text-sm focus-within:ring-1 focus-within:ring-ring"
          />
        ) : (
          <button
            type="button"
            className={cn(
              "w-full text-start text-sm leading-relaxed",
              canEdit && "hover:bg-muted/50 rounded px-1 -mx-1 transition-colors",
              !translated.trim() && "text-muted-foreground italic",
            )}
            onClick={() => canEdit && setEditing(true)}
          >
            {translated.trim() || t("editor.note.empty")}
          </button>
        )}
      </div>

      {onJumpToCell && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={t("terminology.termDetail.goToCellAria", {
            ref: cell.context || cell.group || cell.id.slice(0, 8),
          })}
          onClick={() => onJumpToCell({ cellId: cell.id, fileId: cell.fileId })}
        >
          <SquareArrowOutUpRight />
        </Button>
      )}
    </li>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TerminologyTermDetailProps {
  concept: Concept
  /** All cells for the project (or the active file). Filtered internally. */
  cells: CellData[]
  canEdit: boolean
  projectId: string
  username: string
  onClose: () => void
  /** Called after any commit so the parent can trigger a revalidate. */
  onCellCommitted: () => void
  /** Optimistic patch forwarded from the parent's useCells instance. */
  onOptimisticEdit: (cellId: string, patch: { value: string; valueHtml?: string }) => void
  /** Whether the user may promote a predicted equivalent to a managed rendering. */
  canManageTermbase?: boolean
  /**
   * Promote a predicted target equivalent to an admitted rendering on this
   * concept. Persistence is owned by the parent (patchSettings).
   */
  onPromoteRendering?: (conceptId: string, target: string) => void | Promise<void>
  /** True while the parent is still fetching cells for the examples list. */
  examplesLoading?: boolean
  /** Jump to this occurrence in the editor. */
  onJumpToCell?: (cell: { cellId: string; fileId: string }) => void
  /**
   * AQU-1006 follow-up: replace this concept's rendering list.
   *
   * The detail page could previously only ADD a rendering, by promoting a
   * predicted equivalent — there was no way to remove one or to change a
   * rendering from required to forbidden without leaving for the edit dialog.
   *
   * Takes the WHOLE list rather than a per-item delta because that is what a
   * `term.update` carries: renderings have no stable per-item id to merge on,
   * so the projection replaces them wholesale. Callers emit one event.
   */
  onRenderingsChange?: (conceptId: string, renderings: TermRendering[]) => void | Promise<void>
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TerminologyTermDetail({
  concept,
  cells,
  canEdit,
  projectId,
  username,
  onClose,
  onCellCommitted,
  onOptimisticEdit,
  canManageTermbase = false,
  onPromoteRendering,
  examplesLoading = false,
  onJumpToCell,
  onRenderingsChange,
}: TerminologyTermDetailProps) {
  const t = useT()
  // Per-cell translated values — optimistic updates are already reflected via
  // the parent's useCells applyOptimisticTargetEdit before this renders.
  const occurrences = useMemo(
    () => cells.filter((c) => matchesTerm(c.original, concept.sourceTerm, { caseSensitive: concept.caseSensitive })),
    [cells, concept.sourceTerm, concept.caseSensitive],
  )

  const { enforced, infringed } = useMemo(() => {
    let enforced = 0
    let infringed = 0
    for (const c of occurrences) {
      const v = deriveVerdict(concept, c.original, c.translated)
      if (v === "enforced") enforced++
      else if (v === "infringed") infringed++
    }
    return { enforced, infringed }
  }, [occurrences, concept])

  // Predicted target equivalents over the loaded bilingual cell pairs. χ² + EM
  // cross-check; results stay "AI-assumed" until explicitly promoted.
  const predicted = useMemo(
    () =>
      predictEquivalents(
        cells.map((c) => ({ source: c.original, target: c.translated })),
        concept.sourceTerm,
      ),
    [cells, concept.sourceTerm],
  )

  const handlePromoteEquivalent = useCallback(
    (target: string) => {
      void onPromoteRendering?.(concept.id, target)
    },
    [onPromoteRendering, concept.id],
  )

  // AQU-1006 follow-up: rendering edits. Each helper builds the FULL next list
  // and hands it to the parent, which emits one `term.update` — renderings
  // have no per-item identity to merge on, so they replace wholesale.
  const canEditRenderings = canManageTermbase && Boolean(onRenderingsChange)

  const handleCycleStatus = useCallback(
    (index: number) => {
      const next = concept.renderings.map((r, i) =>
        i === index ? { ...r, status: RENDERING_STATUS_CYCLE[r.status] } : r,
      )
      void onRenderingsChange?.(concept.id, next)
    },
    [concept.renderings, concept.id, onRenderingsChange],
  )

  const handleRemoveRendering = useCallback(
    (index: number) => {
      void onRenderingsChange?.(concept.id, concept.renderings.filter((_, i) => i !== index))
    },
    [concept.renderings, concept.id, onRenderingsChange],
  )

  const [newRendering, setNewRendering] = useState("")
  const handleAddRendering = useCallback(() => {
    const trimmed = newRendering.trim()
    if (!trimmed) return
    // Don't duplicate an existing rendering (case-insensitive), matching the
    // guard the promote path already applies.
    if (concept.renderings.some((r) => r.rendering.trim().toLowerCase() === trimmed.toLowerCase())) {
      setNewRendering("")
      return
    }
    // New renderings land as "admitted", not "preferred": adding one should
    // never silently demote whichever rendering the team already agreed on.
    void onRenderingsChange?.(concept.id, [
      ...concept.renderings,
      { rendering: trimmed, status: "admitted" as const },
    ])
    setNewRendering("")
  }, [newRendering, concept.renderings, concept.id, onRenderingsChange])

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t("terminology.termDetail.closeAria")}
        >
          <X />
        </Button>
        <div className="flex flex-1 items-center gap-2 min-w-0">
          <span className="text-base font-semibold truncate">{concept.sourceTerm}</span>
          <Badge
            variant={
              concept.status === "active"
                ? "default"
                : concept.status === "deprecated"
                  ? "destructive"
                  : "secondary"
            }
            className="text-[10px]"
          >
            {concept.status === "active"
              ? t("terminology.common.statusApproved")
              : concept.status === "draft"
                ? t("terminology.common.statusSuggested")
                : t("terminology.common.statusOld")}
          </Badge>
        </div>
      </header>

      {/* Concept metadata */}
      <div className="border-b px-4 py-3 space-y-2">
        {/* Renderings */}
        <div className="flex flex-wrap items-center gap-1.5">
          {concept.renderings.map((r, i) => (
            <RenderingChip
              key={`${r.rendering}:${i}`}
              rendering={r}
              {...(canEditRenderings
                ? {
                    onCycleStatus: () => handleCycleStatus(i),
                    onRemove: () => handleRemoveRendering(i),
                  }
                : {})}
            />
          ))}
          {canEditRenderings && (
            <span className="inline-flex items-center gap-1">
              <Input
                value={newRendering}
                onChange={(e) => setNewRendering(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    handleAddRendering()
                  }
                }}
                placeholder={t("terminology.termDetail.addRenderingPlaceholder")}
                aria-label={t("terminology.termDetail.addRenderingAria")}
                className="h-6 w-36 text-[11px]"
              />
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={handleAddRendering}
                disabled={!newRendering.trim()}
              >
                {t("terminology.termDetail.addRenderingButton")}
              </Button>
            </span>
          )}
        </div>
        {canEditRenderings && concept.renderings.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {t("terminology.termDetail.renderingEditHint")}
          </p>
        )}

        {/* Notes */}
        {concept.notes && (
          <p className="text-xs text-muted-foreground">{concept.notes}</p>
        )}

        {/* Stats summary — hidden while examples load so we don't flash "0 occurrences". */}
        {!examplesLoading && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>
            <RichMessage
              k="terminology.common.occurrenceCount"
              count={occurrences.length}
              values={{
                count: <span className="font-medium text-foreground">{occurrences.length}</span>,
              }}
            />
          </span>
          {occurrences.length > 0 && (
            <>
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                {t("terminology.termDetail.enforcedCount", { count: enforced })}
              </span>
              {infringed > 0 && (
                <span className="text-destructive font-medium">
                  {t("terminology.termDetail.infringedCount", { count: infringed })}
                </span>
              )}
            </>
          )}
        </div>
        )}
      </div>

      {/* Managed renderings / predicted equivalents don't need the cell query. */}
      <div className="border-b px-4 py-3">
        <EquivalentsPanel
          sourceTerm={concept.sourceTerm}
          managed={concept.renderings}
          predicted={examplesLoading ? [] : predicted}
          canPromote={canManageTermbase && Boolean(onPromoteRendering)}
          onPromote={handlePromoteEquivalent}
        />
      </div>

      {/* Occurrence list — the cells query lives here, not on the whole entry. */}
      {examplesLoading ? (
        <div role="status" className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          {t("terminology.termDetail.loadingExamples")}
        </div>
      ) : (
        <main className="flex-1 overflow-y-auto px-4 py-2">
        {occurrences.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
            <Minus className="h-8 w-8 opacity-30" />
            <p className="text-sm">{t("terminology.termDetail.noOccurrences")}</p>
          </div>
        ) : (
          <>
            {/* Column headers */}
            <div className="mb-2 hidden items-start gap-4 text-xs text-muted-foreground sm:flex">
              <span className="w-24 shrink-0">{t("terminology.termDetail.columnRef")}</span>
              <span className="flex-1">{t("editor.column.source")}</span>
              <span className="w-20 shrink-0">{t("terminology.common.columnVerdict")}</span>
              <span className="flex-1">{t("editor.column.target")}</span>
              {onJumpToCell && <span className="w-8 shrink-0" />}
            </div>
            <ul>
              {occurrences.map((cell) => (
                <OccurrenceRow
                  key={cell.id}
                  cell={cell}
                  concept={concept}
                  translated={cell.translated}
                  canEdit={canEdit}
                  projectId={projectId}
                  username={username}
                  onOptimisticEdit={onOptimisticEdit}
                  onCellCommitted={onCellCommitted}
                  onJumpToCell={onJumpToCell}
                />
              ))}
            </ul>
          </>
        )}
      </main>
      )}
    </div>
  )
}
