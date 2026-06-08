/**
 * InterlinearAlignmentPanel — FRO-207
 *
 * Renders source↔target word alignment links for a single cell in the BT
 * expansion tab. Mirrors Paratext's guess→approve interaction:
 *
 * - HIGH confidence (≥ 0.6)  → shown bold, one-click confirm or invalidate
 * - AMBER confidence (0.3–0.6) → shown italic with "needs confirm" treatment
 * - LOW confidence (< 0.3)   → not shown
 *
 * Confirm/Invalidate call the interlinear.ts API, then persist the mutation as
 * an AlignmentSeed via the `onSeedChange` callback (parent writes to
 * project-settings so it survives reload and feeds back into the model).
 */

import { useMemo } from "react"
import { Check, X } from "lucide-react"
import {
  alignCell,
  confirmAlignment,
  invalidateAlignment,
  CONFIDENCE_AMBER,
  CONFIDENCE_HIGH,
  type AlignmentModel,
  type AlignmentLink,
} from "@/lib/completion/interlinear"
import type { AlignmentSeed } from "@/lib/completion/interlinear"
import { cn } from "@/lib/utils"

export interface InterlinearAlignmentPanelProps {
  /** Raw source-language text for this cell. */
  sourceText: string
  /** Raw target-language text for this cell (the BT or translation). */
  targetText: string
  /** Pre-built alignment model from the parent (ProjectWorkspace). */
  alignmentModel: AlignmentModel | null
  /** Already-persisted seeds so the panel can reflect prior confirmed/invalidated state. */
  confirmedSeeds: AlignmentSeed[]
  /** Called when the user confirms or invalidates an alignment.
   *  Parent is responsible for persisting and passing a refreshed model. */
  onSeedChange: (seed: AlignmentSeed) => void
}

function confidenceLabel(confidence: number): string {
  if (confidence >= CONFIDENCE_HIGH) return "high"
  if (confidence >= CONFIDENCE_AMBER) return "amber"
  return "low"
}

function AlignmentRow({
  link,
  confirmed,
  invalidated,
  onConfirm,
  onInvalidate,
}: {
  link: AlignmentLink
  confirmed: boolean
  invalidated: boolean
  onConfirm: () => void
  onInvalidate: () => void
}) {
  const band = confidenceLabel(link.confidence)
  const pct = Math.round(link.confidence * 100)

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors",
        confirmed
          ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
          : invalidated
            ? "bg-destructive/10 text-destructive line-through opacity-60"
            : band === "high"
              ? "bg-muted/60"
              : "bg-amber-500/8 text-amber-800 dark:text-amber-300",
      )}
    >
      {/* Source token */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono",
          band === "high" ? "font-semibold" : "italic",
        )}
        title={link.srcToken}
      >
        {link.srcToken}
      </span>

      {/* Arrow + confidence badge */}
      <span className="shrink-0 text-muted-foreground">→</span>

      {/* Target token */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono",
          band === "high" ? "font-semibold" : "italic",
        )}
        title={link.tgtToken}
      >
        {link.tgtToken}
      </span>

      {/* Confidence pill */}
      <span
        className={cn(
          "shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium",
          band === "high"
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        )}
        title={`${pct}% confidence`}
      >
        {pct}%
      </span>

      {/* Action buttons — only when not already decided */}
      {!confirmed && !invalidated && (
        <>
          <button
            type="button"
            onClick={onConfirm}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-emerald-500/20 hover:text-emerald-700 dark:hover:text-emerald-300"
            title="Confirm alignment"
            aria-label={`Confirm ${link.srcToken} → ${link.tgtToken}`}
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onInvalidate}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
            title="Invalidate alignment"
            aria-label={`Invalidate ${link.srcToken} → ${link.tgtToken}`}
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}
      {confirmed && (
        <span className="shrink-0 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">✓ confirmed</span>
      )}
      {invalidated && (
        <span className="shrink-0 text-[9px] font-medium text-destructive">✗ rejected</span>
      )}
    </div>
  )
}

export function InterlinearAlignmentPanel({
  sourceText,
  targetText,
  alignmentModel,
  confirmedSeeds,
  onSeedChange,
}: InterlinearAlignmentPanelProps) {
  const links: AlignmentLink[] = useMemo(() => {
    if (!alignmentModel || !sourceText.trim() || !targetText.trim()) return []
    return alignCell(sourceText, targetText, alignmentModel, { threshold: CONFIDENCE_AMBER })
  }, [alignmentModel, sourceText, targetText])

  const confirmedSet = useMemo(() => {
    const s = new Set<string>()
    for (const seed of confirmedSeeds) {
      if (seed.weight > 0) s.add(`${seed.srcToken.toLowerCase()}|${seed.tgtToken.toLowerCase()}`)
    }
    return s
  }, [confirmedSeeds])

  const invalidatedSet = useMemo(() => {
    const s = new Set<string>()
    for (const seed of confirmedSeeds) {
      if (seed.weight < 0) s.add(`${seed.srcToken.toLowerCase()}|${seed.tgtToken.toLowerCase()}`)
    }
    return s
  }, [confirmedSeeds])

  if (!alignmentModel) return null
  if (links.length === 0) return null

  const handleConfirm = (link: AlignmentLink) => {
    confirmAlignment(link.srcToken, link.tgtToken, alignmentModel)
    onSeedChange({ srcToken: link.srcToken, tgtToken: link.tgtToken, weight: 1 })
  }

  const handleInvalidate = (link: AlignmentLink) => {
    invalidateAlignment(link.srcToken, link.tgtToken, alignmentModel)
    onSeedChange({ srcToken: link.srcToken, tgtToken: link.tgtToken, weight: -1 })
  }

  const highLinks = links.filter((l) => l.confidence >= CONFIDENCE_HIGH)
  const amberLinks = links.filter((l) => l.confidence >= CONFIDENCE_AMBER && l.confidence < CONFIDENCE_HIGH)

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Alignment
      </span>

      {highLinks.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {highLinks.map((link) => {
            const key = `${link.srcToken}|${link.tgtToken}`
            return (
              <AlignmentRow
                key={key}
                link={link}
                confirmed={confirmedSet.has(key)}
                invalidated={invalidatedSet.has(key)}
                onConfirm={() => handleConfirm(link)}
                onInvalidate={() => handleInvalidate(link)}
              />
            )
          })}
        </div>
      )}

      {amberLinks.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
            Needs confirmation
          </span>
          {amberLinks.map((link) => {
            const key = `${link.srcToken}|${link.tgtToken}`
            return (
              <AlignmentRow
                key={key}
                link={link}
                confirmed={confirmedSet.has(key)}
                invalidated={invalidatedSet.has(key)}
                onConfirm={() => handleConfirm(link)}
                onInvalidate={() => handleInvalidate(link)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
