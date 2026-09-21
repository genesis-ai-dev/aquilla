/**
 * TerminologyMergeDialog — select 2+ concepts, preview merged result,
 * confirm to persist.
 *
 * The merge operation is performed by mergeConcepts() from the store.
 * The survivor is always the first concept selected (by selection order).
 *
 * Usage:
 *   <TerminologyMergeDialog
 *     open={open}
 *     onOpenChange={setOpen}
 *     concepts={concepts}
 *     onMerge={async (mergeIds, survivorId) => { ... }}
 *   />
 */

import { useState, useMemo } from "react"
import { Merge } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Concept, TermRendering } from "@/lib/terminology/types"
import { renderingStatusLabelKey } from "@/lib/terminology/types"
import { useT } from "@/lib/i18n/I18nProvider"

// ── Merge preview helpers (pure, mirrors store.mergeConcepts logic) ─────────

function buildMergedPreview(
  survivor: Concept,
  others: Concept[],
): Pick<Concept, "renderings" | "notes"> {
  // Union renderings, survivor wins on case-insensitive collision
  const seen = new Map<string, TermRendering>()
  for (const r of survivor.renderings) {
    seen.set(r.rendering.toLowerCase(), r)
  }
  for (const other of others) {
    for (const r of other.renderings) {
      const key = r.rendering.toLowerCase()
      if (!seen.has(key)) seen.set(key, r)
    }
  }

  // Deduplicated notes
  const parts: string[] = []
  const seenNotes = new Set<string>()
  for (const c of [survivor, ...others]) {
    const n = c.notes?.trim()
    if (n && !seenNotes.has(n)) {
      seenNotes.add(n)
      parts.push(n)
    }
  }

  return {
    renderings: [...seen.values()],
    notes: parts.length > 0 ? parts.join(" | ") : undefined,
  }
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function RenderingChipPreview({ rendering }: { rendering: TermRendering }) {
  const t = useT()
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
        rendering.status === "preferred" &&
          "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
        rendering.status === "admitted" && "bg-muted text-muted-foreground",
        rendering.status === "forbidden" &&
          "bg-red-100 text-red-700 line-through dark:bg-red-950 dark:text-red-400",
      )}
    >
      {rendering.rendering}
      <span className="opacity-60">·{t(renderingStatusLabelKey(rendering.status))}</span>
    </span>
  )
}

interface ConceptSelectRowProps {
  concept: Concept
  selected: boolean
  selectionOrder: number | null // 1-based position; null if not selected
  onToggle: (id: string) => void
}

function ConceptSelectRow({
  concept,
  selected,
  selectionOrder,
  onToggle,
}: ConceptSelectRowProps) {
  const t = useT()
  return (
    <button
      type="button"
      data-testid="merge-concept-row"
      onClick={() => onToggle(concept.id)}
      className={cn(
        "w-full flex items-start gap-3 rounded-md border p-3 text-start transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:border-muted-foreground/40",
      )}
    >
      {/* Selection badge */}
      <div className="shrink-0 w-5 mt-0.5">
        {selected ? (
          <Badge
            variant="default"
            className="h-5 w-5 rounded-lg p-0 flex items-center justify-center text-[10px] tabular-nums"
          >
            {selectionOrder}
          </Badge>
        ) : (
          <div className="h-5 w-5 rounded-lg border-2 border-muted-foreground/30" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{concept.sourceTerm}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {concept.renderings.length > 0 ? (
            concept.renderings.map((r, i) => (
              <RenderingChipPreview key={i} rendering={r} />
            ))
          ) : (
            <span className="text-xs text-muted-foreground italic">
              {t("terminology.common.noRenderings")}
            </span>
          )}
        </div>
        {concept.notes && (
          <p className="mt-1 text-xs text-muted-foreground truncate">{concept.notes}</p>
        )}
      </div>

      {/* Survivor label */}
      {selectionOrder === 1 && (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {t("terminology.mergeDialog.survivorBadge")}
        </Badge>
      )}
    </button>
  )
}

// ── Main dialog ──────────────────────────────────────────────────────────────

interface TerminologyMergeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  concepts: Concept[]
  onMerge: (mergeIds: string[], survivorId: string) => Promise<void>
}

type Step = "select" | "preview"

export function TerminologyMergeDialog({
  open,
  onOpenChange,
  concepts,
  onMerge,
}: TerminologyMergeDialogProps) {
  const t = useT()
  const [step, setStep] = useState<Step>("select")
  const [selectedIds, setSelectedIds] = useState<string[]>([]) // ordered by selection
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setStep("select")
    setSelectedIds([])
    setMerging(false)
    setError(null)
  }

  function handleClose() {
    reset()
    onOpenChange(false)
  }

  function toggleConcept(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const survivorId = selectedIds[0] ?? null
  const survivor = concepts.find((c) => c.id === survivorId) ?? null
  const others = selectedIds
    .slice(1)
    .map((id) => concepts.find((c) => c.id === id))
    .filter((c): c is Concept => c !== undefined)

  const preview = useMemo(() => {
    if (!survivor) return null
    return buildMergedPreview(survivor, others)
  }, [survivor, others])

  async function handleConfirmMerge() {
    if (selectedIds.length < 2 || !survivorId) return
    setMerging(true)
    setError(null)
    try {
      await onMerge(selectedIds, survivorId)
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t("terminology.mergeDialog.mergeFailed"))
    } finally {
      setMerging(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="h-4 w-4" />
            {t("terminology.mergeDialog.title")}
          </DialogTitle>
        </DialogHeader>

        {step === "select" ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t("terminology.mergeDialog.selectDescription")}
            </p>

            <div className="max-h-[50vh] overflow-y-auto space-y-2 py-1">
              {concepts.map((c) => {
                const order = selectedIds.indexOf(c.id)
                return (
                  <ConceptSelectRow
                    key={c.id}
                    concept={c}
                    selected={order !== -1}
                    selectionOrder={order === -1 ? null : order + 1}
                    onToggle={toggleConcept}
                  />
                )
              })}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter showCloseButton>
              <Button
                onClick={() => setStep("preview")}
                disabled={selectedIds.length < 2}
              >
                {t("terminology.mergeDialog.previewMergeButton")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t("terminology.mergeDialog.previewDescription")}
            </p>

            {/* Preview card */}
            {preview && survivor && (
              <div
                data-testid="merge-preview"
                className="rounded-md border bg-muted/30 p-4 space-y-3"
              >
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("terminology.mergeDialog.survivorLabel")}
                  </p>
                  <p className="text-sm font-semibold">{survivor.sourceTerm}</p>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("terminology.mergeDialog.mergedRenderingsLabel")}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {preview.renderings.length > 0 ? (
                      preview.renderings.map((r, i) => (
                        <RenderingChipPreview key={i} rendering={r} />
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground italic">
                        {t("terminology.common.noRenderings")}
                      </span>
                    )}
                  </div>
                </div>

                {preview.notes && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("terminology.mergeDialog.combinedNotesLabel")}
                    </p>
                    <p className="text-xs text-muted-foreground">{preview.notes}</p>
                  </div>
                )}

                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("terminology.mergeDialog.conceptsToRemoveLabel")}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {others.map((c) => (
                      <Badge key={c.id} variant="destructive" className="text-[10px]">
                        {c.sourceTerm}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter showCloseButton>
              <Button
                variant="outline"
                onClick={() => setStep("select")}
                disabled={merging}
              >
                {t("common.back")}
              </Button>
              <Button
                variant="destructive"
                onClick={handleConfirmMerge}
                disabled={merging}
                aria-label={t("terminology.mergeDialog.confirmMerge")}
              >
                {merging ? t("terminology.mergeDialog.merging") : t("terminology.mergeDialog.confirmMerge")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
