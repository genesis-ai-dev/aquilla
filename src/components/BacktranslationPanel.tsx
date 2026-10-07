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
  alignmentOpen: boolean
  onAlignmentOpenChange: (open: boolean) => void
  alignmentModel: AlignmentModel | null
  showAlignment: boolean
  onBacktranslate?: (cell: CellData, source: BacktranslationActionSource) => void
  onSaveBacktranslation?: (cell: CellData, btText: string, polished: boolean) => void
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
  alignmentOpen,
  onAlignmentOpenChange,
  alignmentModel,
  showAlignment,
  onBacktranslate,
  onSaveBacktranslation,
  onAlignmentSeedChange,
  confirmedSeeds,
  originalWords,
}: BacktranslationPanelProps) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState("")
  const [saving, setSaving] = useState(false)

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
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] rounded-md bg-muted-foreground/30" />
          <h4 className="text-[11px] font-medium text-foreground">
            {t("editor.bt.statisticalGloss")}
          </h4>
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
            {t("editor.bt.glossDescriptor")}
          </p>
          {gloss ? (
            <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/80">{gloss}</p>
          ) : (
            <p className="mt-1.5 text-[11px] italic text-muted-foreground">
              {t("editor.bt.glossNotEnoughPairs")}
            </p>
          )}
          {disagree && (
            <p className="mt-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {t("editor.bt.pairsDisagree")}
            </p>
          )}
          {disagree && editable && (
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
          {gloss && (
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
