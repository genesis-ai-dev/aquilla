/**
 * InterlinearAlignmentPanel — AQU-207 / AQU-240 / AQU-241
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
 * AQU-241: When `hasSufficientData` is false the panel shows an "insufficient
 * data" empty state instead of spurious low-confidence suggestions.
 *
 * AQU-240: confirm/reject buttons carry descriptive aria-labels and app tooltips that
 * explain how the action feeds the interlinear training loop.
 *
 * AQU-207: a decision stays on screen. The parent rebuilds the model with the
 * new seed, and an invalidation can push the link below the display floor (or
 * hand that source token to a different target), so the row the user just
 * clicked would otherwise vanish — indistinguishable from the click having
 * done nothing. Decided pairs present in this cell that the model no longer
 * proposes are synthesized back into the list, in place, with their state.
 */

import { useMemo } from "react"
import { Check, X, HelpCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  alignCell,
  confirmAlignment,
  invalidateAlignment,
  tokenize,
  CONFIDENCE_HIGH,
  CONFIDENCE_AMBER,
  MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT,
  type AlignmentModel,
  type AlignmentLink,
  type AlignmentSeed,
} from "@/lib/completion/interlinear"
import { alignOriginalWords, type OriginalWordAlignment } from "@/lib/completion/macula-align"
import type { MorphWord } from "@/lib/sync/morph-read"
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
  /** AQU-462: original-language morphology for this cell (Macula Hebrew/Greek
   *  source files). Absent for every other kind of source — the panel then
   *  renders exactly as it did before. */
  originalWords?: readonly MorphWord[]
  /** Called when the user confirms or invalidates an alignment.
   *  Parent is responsible for persisting and passing a refreshed model. */
  onSeedChange: (seed: AlignmentSeed) => void
  /**
   * AQU-1408: may this viewer teach the alignment? Contributor(400)+, the same
   * rung that may correct a back-translation and the same floor the
   * `alignmentSeeds` settings carve-out enforces on the server.
   *
   * Below it the confirm/reject buttons render DISABLED with an explanation
   * rather than vanishing or, worse, staying clickable: a click that the role
   * floor then refuses is a control that does nothing and says nothing, which
   * is the defect AQU-1408 was filed about in the first place.
   *
   * Defaults to true so a caller that does not know the viewer's role — and
   * every existing caller — behaves exactly as before.
   */
  editable?: boolean
}

/**
 * React key for a row. A decision is about the token PAIR (so the decided
 * sets key on `src|tgt`), but a sentence that repeats a word yields one link
 * per position with the same pair — keyed on the pair alone React logged
 * "two children with the same key" for every "you → you" in a verse.
 */
function rowKey(link: AlignmentLink): string {
  return `${link.srcIndex}:${link.srcToken}|${link.tgtIndex}:${link.tgtToken}`
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
  modelled = true,
  editable = true,
  onConfirm,
  onInvalidate,
}: {
  link: AlignmentLink
  confirmed: boolean
  invalidated: boolean
  /** False for a decided pair the model no longer proposes: there is no
   *  confidence to show, only the decision. */
  modelled?: boolean
  /** AQU-1408: contributor(400)+ may teach the alignment; below that the
   *  buttons are disabled with an explanation. */
  editable?: boolean
  onConfirm: () => void
  onInvalidate: () => void
}) {
  const t = useT()
  const band = confirmed ? "high" : confidenceLabel(link.confidence)
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

      {/* Confidence pill — only for a link the model currently proposes */}
      {modelled && (
        <AppTooltip content={t("importExport.preview.confidencePercent", { percent: pct })}>
          <span
            className={cn(
              "shrink-0 rounded-md px-1.5 py-px text-[9px] font-medium",
              band === "high"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
            )}
          >
            {pct}%
          </span>
        </AppTooltip>
      )}

      {/* Action buttons — only when not already decided */}
      {!confirmed && !invalidated && editable && (
        <>
          {/* AQU-240: tooltip/aria-label explains that confirming teaches the glosser */}
          <AppTooltip
            content={t("workspace.alignment.confirmTooltip", { srcToken: link.srcToken, tgtToken: link.tgtToken })}
            className="max-w-xs"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onConfirm}
              className="shrink-0 text-muted-foreground hover:bg-emerald-500/20 hover:text-emerald-700 dark:hover:text-emerald-300"
              aria-label={t("workspace.alignment.confirmAriaLabel", { srcToken: link.srcToken, tgtToken: link.tgtToken })}
            >
              <Check />
            </Button>
          </AppTooltip>
          {/* AQU-240: tooltip/aria-label explains that invalidating penalizes incorrect suggestions */}
          <AppTooltip
            content={t("workspace.alignment.rejectTooltip", { srcToken: link.srcToken, tgtToken: link.tgtToken })}
            className="max-w-xs"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onInvalidate}
              className="shrink-0 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
              aria-label={t("workspace.alignment.rejectAriaLabel", { srcToken: link.srcToken, tgtToken: link.tgtToken })}
            >
              <X />
            </Button>
          </AppTooltip>
        </>
      )}
      {/* AQU-1408: below contributor the decision cannot be saved, so the
          controls say so rather than accepting a click they will drop.
          Disabled-with-a-reason, per 09-design-and-ux "Never disable silently". */}
      {!confirmed && !invalidated && !editable && (
        <AppTooltip content={t("workspace.alignment.contributorRequired")} className="max-w-xs">
          <span className="inline-flex shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled
              aria-label={t("workspace.alignment.contributorRequired")}
              className="shrink-0 text-muted-foreground"
            >
              <Check />
            </Button>
          </span>
        </AppTooltip>
      )}
      {confirmed && (
        <span className="shrink-0 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
          {t("workspace.alignment.confirmedBadge")}
        </span>
      )}
      {invalidated && (
        <span className="shrink-0 text-[9px] font-medium text-destructive">
          {t("workspace.alignment.rejectedBadge")}
        </span>
      )}
    </div>
  )
}

/**
 * AQU-462: one original-language word — its surface form, the morphology the
 * Macula import stored for it, and the target word it maps to.
 *
 * Every word of the verse gets a row, including the ones the model cannot
 * place: an interlinear that silently omits words misrepresents the verse, and
 * the lemma/Strong's/morphology is useful on its own.
 */
function OriginalWordRow({ word }: { word: OriginalWordAlignment }) {
  const t = useT()
  const details = [word.lemma, word.strongs, word.morphCode].filter(Boolean).join(" · ")
  const pct = Math.round(word.confidence * 100)

  return (
    <div className="flex items-baseline gap-2 rounded-md bg-muted/40 px-2 py-1 text-xs">
      <span className="min-w-0 flex-1 truncate">
        <span className="text-sm font-semibold" dir="auto">{word.surface}</span>
        {details && (
          <span className="ml-1.5 text-[10px] text-muted-foreground" dir="auto">{details}</span>
        )}
      </span>

      <span className="shrink-0 text-muted-foreground">→</span>

      <span className="min-w-0 flex-1 truncate">
        {word.tgtToken ? (
          <>
            <span
              className={cn(
                "font-mono",
                word.basis === "surface" ? "font-semibold" : "italic",
              )}
            >
              {word.tgtToken}
            </span>
            {/* i18n-exempt "lemma" is an AlignmentBasis tag, not copy */}
            {word.basis === "lemma" && (
              <AppTooltip
                content={t("workspace.alignment.originalViaLemmaTooltip", {
                  lemma: word.lemma ?? word.surface,
                })}
                className="max-w-xs"
              >
                <span className="ml-1.5 rounded-md bg-amber-500/15 px-1.5 py-px text-[9px] font-medium text-amber-700 dark:text-amber-400">
                  {t("workspace.alignment.originalViaLemma")}
                </span>
              </AppTooltip>
            )}
          </>
        ) : (
          <span className="text-[10px] italic text-muted-foreground/70">
            {t("workspace.alignment.originalNoMatch")}
          </span>
        )}
      </span>

      {word.tgtToken && (
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">
          {pct}%
        </span>
      )}
    </div>
  )
}

function OriginalLanguageSection({ words }: { words: OriginalWordAlignment[] }) {
  const t = useT()
  return (
    <div className="flex flex-col gap-1.5" data-aquilla-original-alignment>
      <div className="flex items-center gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t("workspace.alignment.originalHeading")}
        </span>
        <span className="text-[11px] text-muted-foreground/60">
          {t("workspace.alignment.originalSub")}
        </span>
        <AppTooltip content={t("workspace.alignment.originalHelpTooltip")} className="max-w-xs">
          <span className="cursor-help text-muted-foreground/60 hover:text-muted-foreground">
            <HelpCircle className="h-3 w-3" />
          </span>
        </AppTooltip>
      </div>
      <div className="flex flex-col gap-0.5">
        {words.map((word) => (
          <OriginalWordRow key={word.wordSeq} word={word} />
        ))}
      </div>
    </div>
  )
}

export function InterlinearAlignmentPanel({
  sourceText,
  targetText,
  alignmentModel,
  confirmedSeeds,
  onSeedChange,
  originalWords,
  editable = true,
}: InterlinearAlignmentPanelProps) {
  const t = useT()
  // AQU-241: derive whether the model has enough pairs for non-random results.
  // AlignmentModel.pairCount is the number of (source, target) verse pairs used
  // to train it — read directly from the model so the parent doesn't need to
  // thread an extra prop.
  const hasSufficientData =
    alignmentModel != null &&
    alignmentModel.pairCount >= MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT

  // AQU-241: only compute links when there is sufficient data — avoids wasting
  // cycles on a model that would only produce noise.
  const links: AlignmentLink[] = useMemo(() => {
    if (!hasSufficientData) return []
    if (!alignmentModel || !sourceText.trim() || !targetText.trim()) return []
    // AQU-241: threshold raised to CONFIDENCE_HIGH (0.6) so only high-confidence
    // alignments are surfaced — low-confidence guesses from a small corpus are
    // suppressed rather than presented as equivalent to confident ones.
    return alignCell(sourceText, targetText, alignmentModel, { threshold: CONFIDENCE_HIGH })
  }, [hasSufficientData, alignmentModel, sourceText, targetText])

  // AQU-241 training loop fix: the amber band (0.3–0.6) was the primary path
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

  // AQU-462: the original-language strip. It does NOT depend on the corpus —
  // lemma, Strong's and morphology come from the import — so it renders even in
  // the insufficient-data state. The target links do depend on it, so below the
  // meaningful-alignment floor the words are shown without them rather than
  // with guesses the rest of this panel would refuse to make.
  const originalAlignments: OriginalWordAlignment[] = useMemo(() => {
    if (!originalWords || originalWords.length === 0) return []
    return alignOriginalWords(
      originalWords,
      targetText,
      hasSufficientData ? alignmentModel : null,
    )
  }, [originalWords, targetText, hasSufficientData, alignmentModel])

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

  // AQU-207: decided pairs in this cell that neither band proposes any more.
  // Synthesized on the same token boundaries `alignCell` uses so the row lands
  // where the proposal sat; no confidence — the model has none to report.
  const decidedOnlyLinks: AlignmentLink[] = useMemo(() => {
    if (!hasSufficientData || confirmedSeeds.length === 0) return []
    if (!sourceText.trim() || !targetText.trim()) return []
    const srcTokens = tokenize(sourceText)
    const tgtTokens = tokenize(targetText)
    const proposed = new Set<string>()
    for (const l of links) proposed.add(`${l.srcToken}|${l.tgtToken}`)
    for (const l of amberLinks) proposed.add(`${l.srcToken}|${l.tgtToken}`)
    const out: AlignmentLink[] = []
    for (const seed of confirmedSeeds) {
      if (seed.weight === 0) continue
      const srcToken = seed.srcToken.toLowerCase()
      const tgtToken = seed.tgtToken.toLowerCase()
      const key = `${srcToken}|${tgtToken}`
      if (proposed.has(key)) continue
      const srcIndex = srcTokens.indexOf(srcToken)
      const tgtIndex = tgtTokens.indexOf(tgtToken)
      if (srcIndex < 0 || tgtIndex < 0) continue
      proposed.add(key)
      out.push({ srcIndex, srcToken, tgtIndex, tgtToken, confidence: 0 })
    }
    return out
  }, [hasSufficientData, confirmedSeeds, sourceText, targetText, links, amberLinks])

  // The main list: proposals plus decided-only rows, in sentence order, so a
  // pair keeps its place after the model stops proposing it.
  const mainRows = useMemo(() => {
    const rows = [
      ...links.map((link) => ({ link, modelled: true })),
      ...decidedOnlyLinks.map((link) => ({ link, modelled: false })),
    ]
    return rows.sort((a, b) => a.link.srcIndex - b.link.srcIndex || a.link.tgtIndex - b.link.tgtIndex)
  }, [links, decidedOnlyLinks])

  if (!alignmentModel) return null

  const handleConfirm = (link: AlignmentLink) => {
    confirmAlignment(link.srcToken, link.tgtToken, alignmentModel)
    onSeedChange({ srcToken: link.srcToken, tgtToken: link.tgtToken, weight: 1 })
  }

  const handleInvalidate = (link: AlignmentLink) => {
    invalidateAlignment(link.srcToken, link.tgtToken, alignmentModel)
    onSeedChange({ srcToken: link.srcToken, tgtToken: link.tgtToken, weight: -1 })
  }

  // AQU-241: insufficient-data empty state — shown instead of junk alignments
  // when the project hasn't translated enough sentences for meaningful signal.
  if (!hasSufficientData) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          {/* AQU-241: legend/help tooltip for the Alignment section */}
          <span className="text-xs font-medium text-muted-foreground">
            {t("editor.bt.alignment")}
          </span>
          <AppTooltip
            content={t("workspace.alignment.helpTooltipShort")}
            className="max-w-xs"
          >
            <span className="cursor-help text-muted-foreground/60 hover:text-muted-foreground">
              <HelpCircle className="h-3 w-3" />
            </span>
          </AppTooltip>
        </div>
        <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
          {t("workspace.alignment.insufficientData")}
        </p>
        {originalAlignments.length > 0 && (
          <OriginalLanguageSection words={originalAlignments} />
        )}
      </div>
    )
  }

  // With sufficient data but nothing to show in either band (proposed or
  // decided rows): hide the section entirely — unless there is an
  // original-language strip, which stands on its own.
  if (mainRows.length === 0 && amberLinks.length === 0 && originalAlignments.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5">
      {/* AQU-462: the original-language words lead, because they are the verse
          itself; the statistical link list below is a view over them. */}
      {originalAlignments.length > 0 && (
        <OriginalLanguageSection words={originalAlignments} />
      )}

      {(mainRows.length > 0 || amberLinks.length > 0) && (
        <div className="flex items-center gap-1">
          {/* AQU-241: legend/help tooltip for the Alignment section (AQU-240: explains ✓/✕ controls) */}
          <span className="text-xs font-medium text-muted-foreground">
            {t("editor.bt.alignment")}
          </span>
          <AppTooltip
            content={t("workspace.alignment.helpTooltipFull")}
            className="max-w-xs"
          >
            <span className="cursor-help text-muted-foreground/60 hover:text-muted-foreground">
              <HelpCircle className="h-3 w-3" />
            </span>
          </AppTooltip>
        </div>
      )}

      {mainRows.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {mainRows.map(({ link, modelled }) => {
            const key = `${link.srcToken}|${link.tgtToken}`
            return (
              <AlignmentRow
                key={rowKey(link)}
                link={link}
                modelled={modelled}
                editable={editable}
                confirmed={confirmedSet.has(key)}
                invalidated={invalidatedSet.has(key)}
                onConfirm={() => handleConfirm(link)}
                onInvalidate={() => handleInvalidate(link)}
              />
            )
          })}
        </div>
      )}

      {/* AQU-241 training loop fix: collapsed opt-in disclosure for the
          amber band (0.3–0.6). Small corpora plateau below 0.6 and can
          never train past it if confirm/invalidate is unreachable. The
          disclosure is closed by default so it adds no visual noise for
          projects with sufficient data — users who need to confirm weak
          links can expand it. Count in the summary keeps them aware it
          exists without forcing it on them. */}
      {amberLinks.length > 0 && (
        <details className="rounded-md border border-amber-500/20 bg-amber-500/5">
          <summary className="select-none px-2 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300 list-none flex items-center gap-1">
            <span className="flex-1">{t("workspace.alignment.needsConfirmation", { count: amberLinks.length })}</span>
            <span className="text-[9px] text-muted-foreground/60">30–59%</span>
          </summary>
          <div className="flex flex-col gap-0.5 px-1 pb-1.5 pt-0.5">
            {amberLinks.map((link) => {
              const key = `${link.srcToken}|${link.tgtToken}`
              return (
                <AlignmentRow
                  key={rowKey(link)}
                  link={link}
                  editable={editable}
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
