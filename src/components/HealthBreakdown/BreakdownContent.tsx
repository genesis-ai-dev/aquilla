import type { CellHealthBreakdown } from "@/lib/parsers/types"
import { reviewedBand, examplesBand, consistencyBand, rulesBand } from "./bands"
import { HEALTH_DEFAULTS } from "@/lib/health/defaults"
import { cn } from "@/lib/utils"

interface Props {
  breakdown: CellHealthBreakdown
  /** "cell health" | "file health" | "project health" — drives the heading. */
  scopeLabel: string
  /** Click handler for ancestry / drag cell links. */
  onCellClick?: (cellId: string) => void
  /** Number of major (red) rule infractions, used by the Rules band copy. */
  majorInfractionCount: number
  /** File/project scope only — surfaces the cells dragging the average down. */
  biggestDrags?: Array<{ cellId: string; score: number }>
  /** "popover" pads + caps width for floating use; "inline" lets the parent
   *  container drive layout (e.g. the cell-expansion tab). */
  variant?: "popover" | "inline"
  className?: string
}

function signed(n: number): string {
  if (n === 0) return "0"
  return n > 0 ? `+${n}` : `${n}`
}

/**
 * Pure-content view of a CellHealthBreakdown. Two layouts share the same
 * body: a constrained popover (360px card) and an inline tab (full-width
 * inside CellExpansion). Visual semantics are identical so users see the
 * same numbers wherever the breakdown surfaces.
 */
export function BreakdownContent({
  breakdown, scopeLabel, onCellClick, majorInfractionCount, biggestDrags,
  variant = "popover", className,
}: Props) {
  const caps = HEALTH_DEFAULTS.caps
  const b = breakdown

  const ancestryRows = b.signals.ancestryExamples.slice(0, 5)
  const ancestryOverflow = b.signals.ancestryExamples.length - ancestryRows.length

  const sourceIds = b.signals.neighborhoodSourceCellIds
  const targetIds = b.signals.neighborhoodTargetCellIds
  const overlap = sourceIds.filter((id) => targetIds.includes(id)).length

  return (
    <div
      className={cn(
        "space-y-4 text-sm",
        variant === "popover" && "w-[360px] p-4",
        className,
      )}
    >
      <div className="text-center">
        <div className="text-4xl font-semibold">{b.score}</div>
        <div className="text-xs text-muted-foreground">{scopeLabel}</div>
      </div>

      <div className="border-t" />

      <Section
        label="Reviewed"
        signedValue={signed(-b.validationGap)}
        description={
          reviewedBand(b.validationGap, caps.validationGap) +
          ` · ${b.signals.validatorCount} / ${b.signals.requiredValidations} validators`
        }
      />

      <Section
        label="Examples"
        signedValue={signed(-b.ancestryPenalty)}
        description={examplesBand(b.ancestryPenalty, caps.ancestryPenalty)}
      >
        {ancestryRows.length > 0 && (
          <ul className="mt-1 space-y-0.5 font-mono text-xs">
            {ancestryRows.map((e) => (
              <li key={e.cellId} className="flex justify-between">
                <button
                  type="button"
                  onClick={() => onCellClick?.(e.cellId)}
                  className="underline decoration-dotted hover:text-primary"
                >
                  {e.cellId}
                </button>
                <span className="text-muted-foreground">{e.health}</span>
              </li>
            ))}
            {ancestryOverflow > 0 && (
              <li className="text-muted-foreground">+ {ancestryOverflow} more</li>
            )}
          </ul>
        )}
      </Section>

      <Section
        label="Consistency"
        signedValue={signed(-b.neighborhoodPenalty)}
        description={consistencyBand(b.neighborhoodPenalty, caps.neighborhoodPenalty)}
      >
        <div className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
          <div>Source neighbors: {sourceIds.length}</div>
          <div>Target neighbors: {targetIds.length}</div>
          <div>Overlap: {overlap}</div>
          <div>ID Jaccard: {b.signals.idJaccard.toFixed(2)}</div>
          <div>TF-IDF: {b.signals.tfidfTokenOverlap.toFixed(2)}</div>
        </div>
      </Section>

      <Section
        label="Rules"
        signedValue={signed(-b.rulePenalty)}
        description={rulesBand(b.rulePenalty, caps.rulePenalty, majorInfractionCount)}
      >
        {b.signals.infractions.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {b.signals.infractions.map((inf, i) => (
              <li key={i}>{inf.message || inf.ruleId}</li>
            ))}
          </ul>
        )}
      </Section>

      {biggestDrags && biggestDrags.length > 0 && (
        <div>
          <div className="border-t" />
          <div className="mt-2 font-medium">Biggest drags on health</div>
          <ul className="mt-1 space-y-0.5 font-mono text-xs">
            {biggestDrags.map((d) => (
              <li key={d.cellId} className="flex justify-between">
                <button
                  type="button"
                  onClick={() => onCellClick?.(d.cellId)}
                  className="underline decoration-dotted hover:text-primary"
                >
                  {d.cellId}
                </button>
                <span className="text-muted-foreground">{d.score}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Section({
  label, signedValue, description, children,
}: {
  label: string; signedValue: string; description: string; children?: React.ReactNode
}) {
  return (
    <div>
      <div className="flex justify-between font-medium">
        <span>{label}</span>
        <span className="font-mono">{signedValue}</span>
      </div>
      <div className="text-xs text-muted-foreground">{description}</div>
      {children}
    </div>
  )
}
