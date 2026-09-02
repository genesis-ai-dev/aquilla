/**
 * EquivalentsPanel — target-equivalent surface for a source term.
 *
 * Standalone presentational component. Renders TWO visually distinct groups:
 *
 *   1. "Approved translations" — deterministic Concept renderings. These are
 *      facts the user (or org) decided. Solid, no probabilistic chrome.
 *   2. "Suggested translations" — probabilistic predictions from the internal
 *      alignment cross-check. Each row carries a plain-language confidence
 *      percentage, expandable nearby examples (the evidence it drew
 *      from), and a "Promote to managed rendering" action — promotion is the
 *      explicit user act that crosses the deterministic line (spec Slice 3,
 *      pre-mortem P6).
 *
 * Styling mirrors TerminologyTermDetail.tsx (chips, badges, muted column heads).
 * Pure: no data fetching, no model building — the caller passes both lists in.
 *
 * SWARM-TODO(equiv-glue): mount this in the terminology drill-down / candidate
 *   view. The glue wave should:
 *     - call predictEquivalents(corpusPairs, concept.sourceTerm) to populate
 *       `predicted`, and pass concept.renderings as `managed`;
 *     - wire onPromote to append a TermRendering (status: "admitted") to the
 *       Concept and persist via the terminology store / emit path used by
 *       TerminologyTermDetail.
 *   TRACES: docs/superpowers/specs/2026-06-08-terminology-harden-and-discover-design.md
 *           Slice 3 (interlinear-equivalent prediction; managed vs AI-assumed).
 */

import { useState } from "react"
import { ChevronRight, ChevronDown, ShieldCheck, Sparkles, ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { TermRendering } from "@/lib/terminology/types"
import { renderingStatusLabelKey } from "@/lib/terminology/types"
import type {
  PredictedEquivalent,
} from "@/lib/terminology/equivalents"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatPercent } from "@/lib/i18n/format"

// ─── Managed rendering chip (mirrors TerminologyTermDetail.RenderingChip) ─────

function ManagedChip({ rendering }: { rendering: TermRendering }) {
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

// ─── User-facing confidence ───────────────────────────────────────────────────

function ConfidenceLabel({ score }: { score: number }) {
  const { locale, t } = useI18n()
  return (
    <span className="text-[11px] tabular-nums text-muted-foreground">
      {t("terminology.equivalents.confidence", {
        confidence: formatPercent(score, locale),
      })}
    </span>
  )
}

// ─── Predicted row (expandable few-shot examples + promote) ───────────────────

function PredictedRow({
  prediction,
  canPromote,
  onPromote,
}: {
  prediction: PredictedEquivalent
  canPromote: boolean
  onPromote?: (target: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const hasExamples = prediction.examples.length > 0

  return (
    <li className="flex flex-col gap-1.5 border-b py-2 last:border-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={cn(
            "flex items-center gap-1 text-start",
            hasExamples ? "hover:text-foreground" : "cursor-default",
          )}
          onClick={() => hasExamples && setOpen((v) => !v)}
          aria-expanded={hasExamples ? open : undefined}
          disabled={!hasExamples}
        >
          {hasExamples ? (
            open ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )
          ) : (
            <span className="w-3" />
          )}
          <span className="text-sm font-medium">{prediction.target}</span>
        </button>

        <ConfidenceLabel score={prediction.confidenceScore} />

        {canPromote && onPromote && (
          <AppTooltip content={t("terminology.equivalents.promoteTooltip")}>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[10px]"
              onClick={() => onPromote(prediction.target)}
            >
              <ArrowUp className="h-3 w-3" />
              {t("terminology.equivalents.promoteButton")}
            </Button>
          </AppTooltip>
        )}
      </div>

      {/* Few-shot evidence: the nearby pairs this prediction drew from. */}
      {open && hasExamples && (
        <ul className="ms-4 space-y-1 border-s ps-3">
          {prediction.examples.map((ex, i) => (
            <li key={i} className="text-[11px] leading-relaxed">
              <span className="text-muted-foreground">{ex.source}</span>
              <span className="mx-1 text-muted-foreground/50">→</span>
              <span>{ex.target}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface EquivalentsPanelProps {
  /** Source headword these equivalents belong to (for the heading). */
  sourceTerm: string
  /** Deterministic Concept renderings — the user's managed decisions. */
  managed: TermRendering[]
  /** Probabilistic predictions from the χ² + EM cross-check. */
  predicted: PredictedEquivalent[]
  /** Whether the current user may promote a prediction to a managed rendering. */
  canPromote?: boolean
  /** Called when the user promotes a predicted gloss. Crosses the line. */
  onPromote?: (target: string) => void
  className?: string
}

// ─── Main component ───────────────────────────────────────────────────────────

export function EquivalentsPanel({
  sourceTerm,
  managed,
  predicted,
  canPromote = false,
  onPromote,
  className,
}: EquivalentsPanelProps) {
  const t = useT()
  return (
    <div className={cn("flex flex-col gap-4 text-sm", className)}>
      {/* ── Approved translations ── */}
      <section className="rounded-lg border bg-card p-3">
        <header className="mb-2 flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          <h3 className="text-xs font-semibold text-foreground">
            {t("terminology.equivalents.approvedHeading")}
          </h3>
        </header>
        {managed.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            {t("terminology.equivalents.noManagedRenderings", { term: sourceTerm })}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {managed.map((r, i) => (
              <ManagedChip key={i} rendering={r} />
            ))}
          </div>
        )}
      </section>

      {/* ── Suggested translations ── */}
      <section className="rounded-lg border bg-muted/20 p-3">
        <header className="mb-2 flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
          <h3 className="text-xs font-semibold text-foreground">
            {t("terminology.equivalents.suggestedHeading")}
          </h3>
          <span className="text-[10px] text-muted-foreground">
            {t("terminology.equivalents.suggestedSubtitle")}
          </span>
        </header>
        {predicted.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            {t("terminology.equivalents.noPredicted")}
          </p>
        ) : (
          <ul>
            {[...predicted]
              .sort((a, b) => b.confidenceScore - a.confidenceScore)
              .map((p) => (
                <PredictedRow
                  key={p.target}
                  prediction={p}
                  canPromote={canPromote}
                  onPromote={onPromote}
                />
              ))}
          </ul>
        )}
      </section>
    </div>
  )
}
