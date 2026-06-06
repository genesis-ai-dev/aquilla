/**
 * TerminologyTermDetail — per-concept drill-down view.
 *
 * Shows every cell occurrence of the selected concept, the current target
 * translation, the enforcement verdict (enforced / infringed / n/a), and a
 * lightweight inline target editor for contributor+ users.
 *
 * Deliberately minimal: no rail, no audio, no validation UI.  The commit
 * path mirrors EditorTable: emitTargetCellCommit → outbox → D1 projection.
 */

import { useMemo, useCallback, useState } from "react"
import { X, CheckCircle2, AlertCircle, Minus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Concept, TermRendering, RenderingStatus } from "@/lib/terminology/types"
import type { CellData } from "@/hooks/useCells"
import { TranslatedEditor } from "@/components/TranslatedEditor"
import type { TranslatedEditorCommit } from "@/components/TranslatedEditor"
import { emitTargetCellCommit } from "@/lib/sync/events-emit"

// ─── Status label helpers (mirror TerminologyPage) ───────────────────────────

const statusLabel: Record<RenderingStatus, string> = {
  preferred: "required",
  admitted: "alternate",
  forbidden: "forbidden",
}

function RenderingChip({ rendering }: { rendering: TermRendering }) {
  const chipClass = cn(
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
    rendering.status === "preferred" &&
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
    rendering.status === "admitted" && "bg-muted text-muted-foreground",
    rendering.status === "forbidden" &&
      "bg-red-100 text-red-700 line-through dark:bg-red-950 dark:text-red-400",
  )
  return (
    <span className={chipClass}>
      {rendering.rendering}
      <span className="opacity-60">·{statusLabel[rendering.status]}</span>
    </span>
  )
}

// ─── Verdict derivation (mirrors evaluateCell in stats.ts) ───────────────────

type Verdict = "enforced" | "infringed" | "na"

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function termRegex(term: string): RegExp {
  return new RegExp(`\\b${escapeRegex(term)}\\b`, "i")
}

function deriveVerdict(concept: Concept, original: string, translated: string): Verdict {
  if (!termRegex(concept.sourceTerm).test(original)) return "na"

  const approved = concept.renderings.filter(
    (r) => r.status === "preferred" || r.status === "admitted",
  )
  const forbidden = concept.renderings.filter((r) => r.status === "forbidden")

  if (forbidden.some((f) => termRegex(f.rendering).test(translated))) return "infringed"
  if (approved.length > 0) {
    return approved.some((a) => termRegex(a.rendering).test(translated))
      ? "enforced"
      : "infringed"
  }
  return "enforced"
}

// ─── Verdict chip ─────────────────────────────────────────────────────────────

function VerdictChip({ verdict }: { verdict: Verdict }) {
  if (verdict === "na") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
        <Minus className="h-3 w-3" />
        n/a
      </span>
    )
  }
  if (verdict === "enforced") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        enforced
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-destructive">
      <AlertCircle className="h-3 w-3" />
      infringed
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
}: OccurrenceRowProps) {
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
        {cell.group || cell.id.slice(0, 8)}
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
              "w-full text-left text-sm leading-relaxed",
              canEdit && "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1 transition-colors",
              !translated.trim() && "text-muted-foreground italic",
            )}
            onClick={() => canEdit && setEditing(true)}
            title={canEdit ? "Click to edit" : undefined}
          >
            {translated.trim() || "(empty)"}
          </button>
        )}
      </div>
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
}: TerminologyTermDetailProps) {
  // Per-cell translated values — optimistic updates are already reflected via
  // the parent's useCells applyOptimisticTargetEdit before this renders.
  const occurrences = useMemo(
    () => cells.filter((c) => termRegex(concept.sourceTerm).test(c.original)),
    [cells, concept.sourceTerm],
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

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close detail">
          <X className="h-4 w-4" />
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
              ? "approved"
              : concept.status === "draft"
                ? "suggested"
                : "old"}
          </Badge>
        </div>
      </header>

      {/* Concept metadata */}
      <div className="border-b px-4 py-3 space-y-2">
        {/* Renderings */}
        <div className="flex flex-wrap gap-1.5">
          {concept.renderings.map((r, i) => (
            <RenderingChip key={i} rendering={r} />
          ))}
        </div>

        {/* Notes */}
        {concept.notes && (
          <p className="text-xs text-muted-foreground">{concept.notes}</p>
        )}

        {/* Stats summary */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">{occurrences.length}</span> occurrence
            {occurrences.length !== 1 ? "s" : ""}
          </span>
          {occurrences.length > 0 && (
            <>
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                {enforced} enforced
              </span>
              {infringed > 0 && (
                <span className="text-destructive font-medium">{infringed} infringed</span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Occurrence list */}
      <main className="flex-1 overflow-y-auto px-4 py-2">
        {occurrences.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
            <Minus className="h-8 w-8 opacity-30" />
            <p className="text-sm">No occurrences found in the loaded cells.</p>
          </div>
        ) : (
          <>
            {/* Column headers */}
            <div className="mb-2 hidden items-start gap-4 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:flex">
              <span className="w-24 shrink-0">Ref</span>
              <span className="flex-1">Source</span>
              <span className="w-20 shrink-0">Verdict</span>
              <span className="flex-1">Target</span>
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
                />
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  )
}
