/**
 * InterlinearAlignmentPanel — FRO-207 / FRO-240 / FRO-241
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
 *
 * FRO-241: When `hasSufficientData` is false the panel shows an "insufficient
 * data" empty state instead of spurious low-confidence suggestions.
 *
 * FRO-240: confirm/reject buttons carry descriptive aria-labels and app tooltips that
 * explain how the action feeds the interlinear training loop.
 */

import { useMemo } from "react"
import { Check, X, HelpCircle } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  alignCell,
  confirmAlignment,
  invalidateAlignment,
  CONFIDENCE_HIGH,
  CONFIDENCE_AMBER,
  MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT,
  type AlignmentModel,
  type AlignmentLink,
  type AlignmentSeed,
} from "@/lib/completion/interlinear"
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
  // CONFIDENCE_AMBER = 0.3 — amber band used for styling only (alignCell already
  // filters by CONFIDENCE_HIGH, so this branch only fires for confirmed/invalidated
  // seeds re-rendered below the threshold).
  if (confidence >= 0.3) return "amber"
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
      <AppTooltip content={link.srcToken}>
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono",
            band === "high" ? "font-semibold" : "italic",
          )}
        >
          {link.srcToken}
        </span>
      </AppTooltip>

      {/* Arrow + confidence badge */}
      <span className="shrink-0 text-muted-foreground">→</span>

      {/* Target token */}
      <AppTooltip content={link.tgtToken}>
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono",
            band === "high" ? "font-semibold" : "italic",
          )}
        >
          {link.tgtToken}
        </span>
      </AppTooltip>

      {/* Confidence pill */}
      <AppTooltip content={`${pct}% confidence`}>
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium",
            band === "high"
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
          )}
        >
          {pct}%
        </span>
      </AppTooltip>

      {/* Action buttons — only when not already decided */}
      {!confirmed && !invalidated && (
        <>
          {/* FRO-240: tooltip/aria-label explains that confirming teaches the glosser */}
          <AppTooltip
            content={`Confirm: mark "${link.srcToken} -> ${link.tgtToken}" as a correct word-level alignment. Confirmed pairs teach the statistical glosser and improve future back-translations.`}
            className="max-w-xs"
          >
            <button
              type="button"
              onClick={onConfirm}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-emerald-500/20 hover:text-emerald-700 dark:hover:text-emerald-300"
              aria-label={`Confirm alignment: ${link.srcToken} translates as ${link.tgtToken}. This teaches the glosser.`}
            >
              <Check className="h-3 w-3" />
            </button>
          </AppTooltip>
          {/* FRO-240: tooltip/aria-label explains that invalidating penalizes incorrect suggestions */}
          <AppTooltip
            content={`Reject: mark "${link.srcToken} -> ${link.tgtToken}" as an incorrect alignment. Rejected pairs are penalized so this suggestion won't appear again.`}
            className="max-w-xs"
          >
            <button
              type="button"
              onClick={onInvalidate}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
              aria-label={`Reject alignment: ${link.srcToken} does not translate as ${link.tgtToken}. This penalizes the glosser suggestion.`}
            >
              <X className="h-3 w-3" />
            </button>
          </AppTooltip>
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
  // FRO-241: derive whether the model has enough pairs for non-random results.
  // AlignmentModel.pairCount is the number of (source, target) verse pairs used
  // to train it — read directly from the model so the parent doesn't need to
  // thread an extra prop.
  const hasSufficientData =
    alignmentModel != null &&
    alignmentModel.pairCount >= MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT

  // FRO-241: only compute links when there is sufficient data — avoids wasting
  // cycles on a model that would only produce noise.
  const links: AlignmentLink[] = useMemo(() => {
    if (!hasSufficientData) return []
    if (!alignmentModel || !sourceText.trim() || !targetText.trim()) return []
    // FRO-241: threshold raised to CONFIDENCE_HIGH (0.6) so only high-confidence
    // alignments are surfaced — low-confidence guesses from a small corpus are
    // suppressed rather than presented as equivalent to confident ones.
    return alignCell(sourceText, targetText, alignmentModel, { threshold: CONFIDENCE_HIGH })
  }, [hasSufficientData, alignmentModel, sourceText, targetText])

  // FRO-241 training loop fix: the amber band (0.3–0.6) was the primary path
  // for small corpora to feed AlignmentSeeds back — raising the display floor
  // to 0.6 severed it. Keep those links accessible via a collapsed disclosure
  // so confirm/invalidate stays reachable without adding noise to the main view.
  const amberLinks: AlignmentLink[] = useMemo(() => {
    if (!hasSufficientData) return []
    if (!alignmentModel || !sourceText.trim() || !targetText.trim()) return []
    // Compute ALL links at the amber floor, then exclude the high-confidence ones
    // already shown in the main section to avoid duplicates.
    const allAmber = alignCell(sourceText, targetText, alignmentModel, { threshold: CONFIDENCE_AMBER })
    const highKeys = new Set(links.map((l) => `${l.srcToken}|${l.tgtToken}`))
    return allAmber.filter((l) => !highKeys.has(`${l.srcToken}|${l.tgtToken}`))
  }, [hasSufficientData, alignmentModel, sourceText, targetText, links])

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

  const handleConfirm = (link: AlignmentLink) => {
    confirmAlignment(link.srcToken, link.tgtToken, alignmentModel)
    onSeedChange({ srcToken: link.srcToken, tgtToken: link.tgtToken, weight: 1 })
  }

  const handleInvalidate = (link: AlignmentLink) => {
    invalidateAlignment(link.srcToken, link.tgtToken, alignmentModel)
    onSeedChange({ srcToken: link.srcToken, tgtToken: link.tgtToken, weight: -1 })
  }

  // FRO-241: insufficient-data empty state — shown instead of junk alignments
  // when the project hasn't translated enough sentences for meaningful signal.
  if (!hasSufficientData) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          {/* FRO-241: legend/help tooltip for the Alignment section */}
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Alignment
          </span>
          <AppTooltip
            content="Word-level alignment links source and target tokens using a statistical model built from your translated cells. Confirm correct alignments to improve future back-translations; reject incorrect ones to penalize bad suggestions."
            className="max-w-xs"
          >
            <span className="cursor-help text-muted-foreground/60 hover:text-muted-foreground">
              <HelpCircle className="h-3 w-3" />
            </span>
          </AppTooltip>
        </div>
        <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
          Keep translating — word-level alignments become meaningful once more sentences are validated.
        </p>
      </div>
    )
  }

  // With sufficient data but no links in either band: hide the section entirely.
  if (links.length === 0 && amberLinks.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        {/* FRO-241: legend/help tooltip for the Alignment section (FRO-240: explains ✓/✕ controls) */}
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Alignment
        </span>
        <AppTooltip
          content="Word-level alignment: the statistical model links source and target tokens based on your translated cells. Confirm correct pairs to teach the glosser; reject wrong ones to penalize them. Both actions improve future back-translations. Only high-confidence suggestions are shown."
          className="max-w-xs"
        >
          <span className="cursor-help text-muted-foreground/60 hover:text-muted-foreground">
            <HelpCircle className="h-3 w-3" />
          </span>
        </AppTooltip>
      </div>

      {links.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {links.map((link) => {
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

      {/* FRO-241 training loop fix: collapsed opt-in disclosure for the
          amber band (0.3–0.6). Small corpora plateau below 0.6 and can
          never train past it if confirm/invalidate is unreachable. The
          disclosure is closed by default so it adds no visual noise for
          projects with sufficient data — users who need to confirm weak
          links can expand it. Count in the summary keeps them aware it
          exists without forcing it on them. */}
      {amberLinks.length > 0 && (
        <details className="rounded-md border border-amber-500/20 bg-amber-500/5">
          <summary className="cursor-pointer select-none px-2 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300 list-none flex items-center gap-1">
            <span className="flex-1">Needs confirmation ({amberLinks.length})</span>
            <span className="text-[9px] text-muted-foreground/60">30–59%</span>
          </summary>
          <div className="flex flex-col gap-0.5 px-1 pb-1.5 pt-0.5">
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
        </details>
      )}
    </div>
  )
}
