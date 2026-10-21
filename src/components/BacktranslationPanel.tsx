/**
 * Trust-first back-translation panel.
 *
 * Two readings of the translation, each labelled with what KIND of output it
 * is, in the order a translator should meet them (AQU-1408, Biblica ETT):
 *
 *   1. The STATISTICAL GLOSS — literal, word-for-word, derived from this
 *      project's own translated pairs. It is the project's own evidence, so it
 *      leads, and it is always on screen rather than folded into an expander.
 *   2. The AI BACK-TRANSLATION — a smoothed re-reading, with provenance (AI vs
 *      hand-corrected) and freshness always visible.
 *
 * Before AQU-1408 the AI reading was the main block and the gloss was a
 * collapsed section beneath it, which read as "the AI is the answer and the
 * corpus is a footnote" — the opposite of what the gloss is for. Neither
 * descriptor lives in a tooltip any more: a reader who does not know which
 * of the two they are looking at cannot weigh either.
 *
 * Alignment stays collapsed as an advanced tool.
 */

import { useCallback, useState } from "react"
import {
  AlertTriangle, Check, ChevronRight, FileText, Info, Pencil, RefreshCw, Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { CellData } from "@/hooks/useCells"
import { InterlinearAlignmentPanel } from "@/components/InterlinearAlignmentPanel"
import { readingsDisagree, type BacktranslationActionSource } from "@/lib/completion/bt-record"
import type { AlignmentModel, AlignmentSeed } from "@/lib/completion/interlinear"
import type { MorphWord } from "@/lib/sync/morph-read"

export interface BacktranslationPanelProps {
  cell: CellData
  visibleTranslated: string
  editable: boolean
  isBacktranslationConfigured?: boolean
  isBacktranslating?: boolean
  backtranslationError?: string
  statisticalGloss: string
  /** AQU-1408 §1: true when `statisticalGloss` is a saved human correction
   *  rather than the corpus-derived computation. */
  glossCorrected?: boolean
  alignmentOpen: boolean
  onAlignmentOpenChange: (open: boolean) => void
  alignmentModel: AlignmentModel | null
  showAlignment: boolean
  onBacktranslate?: (cell: CellData, source: BacktranslationActionSource) => void
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
  /** AQU-1408 §1: save a correction to the statistical gloss. Empty text
   *  withdraws the correction and restores the computed gloss. */
  onSaveGloss?: (cell: CellData, glossText: string) => void
  onAlignmentSeedChange?: (seed: AlignmentSeed) => void
  confirmedSeeds?: AlignmentSeed[]
  /** AQU-462: original-language (Macula Hebrew/Greek) words for this cell, when
   *  the source file carries morphology. Empty for every other source. */
  originalWords?: readonly MorphWord[]
}

function readingCell(cell: CellData, visibleTranslated: string): CellData {
  return { ...cell, translated: visibleTranslated }
}

export function BacktranslationPanel({
  cell,
  visibleTranslated,
  editable,
  isBacktranslationConfigured,
  isBacktranslating,
  backtranslationError,
  statisticalGloss,
  glossCorrected,
  alignmentOpen,
  onAlignmentOpenChange,
  alignmentModel,
  showAlignment,
  onBacktranslate,
  onSaveBacktranslation,
  onSaveGloss,
  onAlignmentSeedChange,
  confirmedSeeds,
  originalWords,
}: BacktranslationPanelProps) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState("")
  const [saving, setSaving] = useState(false)
  // AQU-1408 §1: the gloss editor is its own state. Reusing the AI reading's
  // would make opening one close the other, and the two are routinely read
  // against each other — that is the whole reason both are on screen.
  const [glossEditing, setGlossEditing] = useState(false)
  const [glossEditValue, setGlossEditValue] = useState("")

  const hasTranslation = visibleTranslated.trim().length > 0
  const reading = cell.backtranslation?.trim() ?? ""
  const readingStale = Boolean(reading && cell.backtranslationForText !== visibleTranslated)
  const originCorrected = cell.backtranslationPolished === false
  const gloss = statisticalGloss.trim()
  const disagree = Boolean(reading && !readingStale && readingsDisagree(reading, gloss))

  const subject = readingCell(cell, visibleTranslated)

  const startEdit = useCallback(() => {
    setEditValue(cell.backtranslation ?? "")
    setEditing(true)
  }, [cell.backtranslation])

  const cancelEdit = useCallback(() => {
    setEditing(false)
    setEditValue("")
  }, [])

  const startGlossEdit = useCallback(() => {
    setGlossEditValue(gloss)
    setGlossEditing(true)
  }, [gloss])

  const cancelGlossEdit = useCallback(() => {
    setGlossEditing(false)
    setGlossEditValue("")
  }, [])

  /**
   * An empty box is not a cancel: it is how a contributor says "my correction
   * was wrong, go back to the corpus". `onSaveGloss` takes it and the cell
   * falls back to the computed gloss, so the withdrawal reaches other members
   * the same way the correction did.
   */
  const saveGlossEdit = useCallback((text: string) => {
    const next = text.trim()
    if (next === gloss.trim()) {
      setGlossEditing(false)
      return
    }
    onSaveGloss?.(subject, next)
    setGlossEditing(false)
  }, [gloss, onSaveGloss, subject])

  const saveEdit = useCallback((text: string) => {
    const next = text.trim()
    if (!next) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      onSaveBacktranslation?.(subject, next, false)
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }, [onSaveBacktranslation, subject])

  return (
    <div className="flex flex-col gap-2.5">
      {/* AQU-1408 §3/§4: the statistical gloss leads, labelled with what it is.
          It is the project's own evidence about its own words, so it is not
          folded away behind an expander and not gated on the AI reading being
          absent — it is simply the first thing in the tab. */}
      {hasTranslation && !editing && (
        <section className="relative overflow-hidden rounded-xl bg-muted/40 py-2.5 pr-3 pl-4">
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-0 left-0 w-[3px] rounded-md",
              glossCorrected ? "bg-emerald-500/55" : "bg-muted-foreground/30",
            )}
          />
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <h4 className="text-[11px] font-medium text-foreground">
                  {t("editor.bt.statisticalGloss")}
                </h4>
                {/* AQU-1408 §1: the corpus's own guess and a colleague's
                    correction of it are different claims, and the reader is
                    being asked to trust one of them. Say which this is. */}
                {glossCorrected && (
                  <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                    {t("editor.bt.glossCorrected")}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                {t("editor.bt.glossDescriptor")}
              </p>
            </div>
            {/* The gloss is editable whenever there is a translation to gloss —
                not only once the corpus managed to produce one. A project whose
                pairs are too thin for a gloss is exactly the project whose
                reviewers have the most to correct (AQU-1408, Biblica ETT). */}
            {!glossEditing && (editable ? (
              <AppTooltip content={t("editor.bt.glossEditTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={startGlossEdit}
                  aria-label={t("editor.bt.glossEditAria")}
                  className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <Pencil />
                </Button>
              </AppTooltip>
            ) : (
              <AppTooltip content={t("editor.bt.glossContributorRequired")}>
                <span className="inline-flex shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled
                    aria-label={t("editor.bt.glossContributorRequired")}
                    className="rounded-full text-muted-foreground"
                  >
                    <Pencil />
                  </Button>
                </span>
              </AppTooltip>
            ))}
          </div>
          {glossEditing ? (
            <div className="mt-1.5 flex flex-col gap-1.5">
              <textarea
                autoFocus
                value={glossEditValue}
                onChange={(e) => setGlossEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") cancelGlossEdit()
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveGlossEdit(glossEditValue)
                }}
                rows={3}
                aria-label={t("editor.bt.glossEditAria")}
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                {t("editor.bt.glossEditHint")}
              </p>
              <div className="flex items-center justify-end gap-1.5">
                <Button type="button" variant="ghost" size="xs" onClick={cancelGlossEdit}>
                  {t("common.cancel")}
                </Button>
                <Button type="button" size="xs" onClick={() => saveGlossEdit(glossEditValue)}>
                  {t("common.save")}
                </Button>
              </div>
            </div>
          ) : gloss ? (
            <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/80">{gloss}</p>
          ) : (
            <p className="mt-1.5 text-[11px] italic text-muted-foreground">
              {t("editor.bt.glossNotEnoughPairs")}
            </p>
          )}
          {disagree && !glossEditing && (
            <p className="mt-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {t("editor.bt.pairsDisagree")}
            </p>
          )}
          {disagree && editable && !glossEditing && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="mt-1 h-auto px-2 py-0.5 text-[11px]"
              onClick={() => onSaveBacktranslation?.(subject, gloss, false)}
            >
              {t("editor.bt.usePairsInstead")}
            </Button>
          )}
          {/* The disclaimer describes how the COMPUTED gloss was made. Once a
              person has corrected it, saying "built statistically, expect rough
              word choices" is no longer true of what is on screen. */}
          {gloss && !glossCorrected && !glossEditing && (
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
              {t("editor.bt.glossDisclaimer")}
            </p>
          )}
        </section>
      )}

      {/* AQU-1408 §3/§4: the AI reading moves below the gloss and carries its
          own visible descriptor. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-foreground">{t("editor.bt.aiHeading")}</span>
            <AppTooltip content={t("editor.bt.explainTooltip")}>
              <Info className="h-3 w-3 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
            </AppTooltip>
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {t("editor.bt.aiDescriptor")}
          </p>
        </div>
        {reading && !editing && (
          <div className="flex items-center gap-0.5">
            {editable && (
              <AppTooltip content={
                !isBacktranslationConfigured
                  ? t("editor.bt.needsAiTooltip")
                  : t("editor.bt.regenerateTooltip")
              }>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={!isBacktranslationConfigured || isBacktranslating}
                  onClick={() => onBacktranslate?.(subject, "regenerate")}
                  aria-label={t("editor.bt.regenerateAria")}
                  className="rounded-full text-muted-foreground hover:text-foreground"
                >
                  {isBacktranslating ? <Spinner className="size-3.5" /> : <RefreshCw />}
                </Button>
              </AppTooltip>
            )}
            {editable ? (
              <AppTooltip content={t("editor.bt.editTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={startEdit}
                  aria-label={t("editor.bt.editTooltip")}
                  className="rounded-full text-muted-foreground hover:text-foreground"
                >
                  <Pencil />
                </Button>
              </AppTooltip>
            ) : (
              <AppTooltip content={t("editor.bt.contributorRequired")}>
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled
                    aria-label={t("editor.bt.contributorRequired")}
                    className="rounded-full text-muted-foreground"
                  >
                    <Pencil />
                  </Button>
                </span>
              </AppTooltip>
            )}
          </div>
        )}
      </div>

      {!hasTranslation ? (
        <div className="flex flex-col items-center gap-1.5 rounded-xl bg-muted/40 px-3 py-6 text-center">
          <FileText className="h-4 w-4 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">{t("editor.bt.translateFirst")}</p>
        </div>
      ) : reading ? (
        <>
          {readingStale && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-500/[0.08] px-3 py-1.5">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                {t("editor.bt.staleWarning")}
              </span>
              {editable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onBacktranslate?.(subject, "refresh")}
                  disabled={!isBacktranslationConfigured || isBacktranslating}
                  className="h-auto shrink-0 gap-1 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-500/25 dark:text-amber-200"
                >
                  {isBacktranslating ? <Spinner className="size-3.5" /> : <RefreshCw />}
                  {t("common.refresh")}
                </Button>
              )}
            </div>
          )}
          {editing ? (
            <div className="flex flex-col gap-1.5">
              <textarea
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") cancelEdit()
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit(editValue)
                }}
                rows={3}
                className="w-full resize-none rounded-lg border border-border bg-background px-3.5 py-3 text-[15px] leading-relaxed text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex items-center justify-end gap-1.5">
                <Button type="button" variant="ghost" size="xs" onClick={cancelEdit}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  onClick={() => saveEdit(editValue)}
                  disabled={saving || !editValue.trim()}
                >
                  {saving ? t("common.saving") : t("common.save")}
                </Button>
              </div>
            </div>
          ) : (
            <div
              className={cn(
                "relative overflow-hidden rounded-xl py-3 pr-4 pl-4",
                readingStale ? "bg-amber-500/[0.06]" : "bg-muted/50",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute inset-y-0 left-0 w-[3px] rounded-md",
                  readingStale ? "bg-amber-500/70" : originCorrected ? "bg-emerald-500/55" : "bg-primary/35",
                )}
              />
              <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium">
                {/* AQU-1408: the section heading above already says "AI
                    back-translation", so the origin badge only earns its space
                    when it contradicts that — i.e. a human rewrote the reading. */}
                {originCorrected && (
                  <span className="text-emerald-700 dark:text-emerald-400">
                    {t("editor.bt.originCorrected")}
                  </span>
                )}
                {!readingStale && (
                  <span className="inline-flex items-center gap-1 text-emerald-700/80 dark:text-emerald-400/80">
                    <Check className="h-3 w-3" />
                    {t("editor.bt.freshLabel")}
                  </span>
                )}
              </div>
              <p className="text-[15px] leading-relaxed text-foreground/90">
                {cell.backtranslation}
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center gap-2.5 rounded-xl bg-muted/40 px-3 py-6 text-center">
          <p className="max-w-[34ch] text-xs leading-relaxed text-muted-foreground">
            {t("editor.bt.emptyPitch")}
          </p>
          {editable ? (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => onBacktranslate?.(subject, "read-back")}
                disabled={!isBacktranslationConfigured || isBacktranslating}
              >
                {isBacktranslating ? (
                  <><Spinner className="size-3.5" /> {t("editor.bt.readingItBack")}</>
                ) : (
                  <><Sparkles /> {t("editor.bt.readItBack")}</>
                )}
              </Button>
              {!isBacktranslationConfigured && (
                <p className="text-[11px] text-muted-foreground/70">
                  {t("editor.bt.needsAiHint")}
                </p>
              )}
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground/70">
              {t("editor.bt.contributorCanGenerate")}
            </p>
          )}
        </div>
      )}

      {showAlignment && cell.original.trim() && hasTranslation && !editing && (
        <div className="rounded-lg border border-border/60">
          <button
            type="button"
            onClick={() => onAlignmentOpenChange(!alignmentOpen)}
            aria-expanded={alignmentOpen}
            className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <ChevronRight className={cn("h-3 w-3 shrink-0", alignmentOpen && "rotate-90")} />
            {t("editor.bt.alignment")}
            <span className="font-normal text-muted-foreground/60">{t("editor.bt.alignmentSub")}</span>
          </button>
          {alignmentOpen && alignmentModel && (
            <div data-aquilla-alignment-panel className="px-2.5 pb-2.5">
              <InterlinearAlignmentPanel
                sourceText={cell.original}
                targetText={visibleTranslated}
                alignmentModel={alignmentModel}
                confirmedSeeds={confirmedSeeds ?? []}
                onSeedChange={onAlignmentSeedChange ?? (() => undefined)}
                originalWords={originalWords}
                editable={editable}
              />
            </div>
          )}
        </div>
      )}

      {backtranslationError && (
        <p className="text-xs text-destructive">{backtranslationError}</p>
      )}
    </div>
  )
}
