// Bible Swap: the optional second step of a Biblica study-notes round-trip.
// The notes export already puts translated notes back into the original Study
// Bible IDML; Bible Swap additionally replaces the English verse text with
// scripture from a translated Bible IDML, so notes and Bible ship in one file.
//
// Only rendered for files imported by the Biblica Study Notes importer — the
// swap engine keys off Biblica's `meta:c` / `cv:v` marker conventions and means
// nothing for any other IDML.

import { useCallback, useEffect, useRef, useState } from "react"
import { Book, FileArchive, X } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { BIBLE_SWAP_LANGUAGES } from "@/lib/biblica/bible-swap/language-mappings"
import type { BibleSwapCompatibilityReport } from "@/lib/biblica/bible-swap/compatibility"
import type {
  BibleSwapSelection,
  BibleSwapSettings,
} from "@/lib/biblica/bible-swap/settings"

export interface BibleSwapPanelProps {
  settings: BibleSwapSettings
  onChange: (settings: BibleSwapSettings) => void
  /** Study volumes in scope, used to score the chosen Bible before export. */
  onAnalyze?: (bibleFile: File) => Promise<BibleSwapCompatibilityReport>
  disabled?: boolean
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function BibleSwapPanel({
  settings,
  onChange,
  onAnalyze,
  disabled = false,
}: BibleSwapPanelProps) {
  const t = useT()
  const [report, setReport] = useState<BibleSwapCompatibilityReport | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)

  // Guards against a slow analysis of a Bible the user has already replaced.
  const analysisSequence = useRef(0)

  const runAnalysis = useCallback(
    async (file: File) => {
      if (!onAnalyze) return
      const sequence = ++analysisSequence.current
      setAnalyzing(true)
      setAnalyzeError(null)
      setReport(null)
      try {
        const result = await onAnalyze(file)
        if (analysisSequence.current !== sequence) return
        setReport(result)
      } catch (err) {
        if (analysisSequence.current !== sequence) return
        setAnalyzeError(err instanceof Error ? err.message : String(err))
      } finally {
        if (analysisSequence.current === sequence) setAnalyzing(false)
      }
    },
    [onAnalyze],
  )

  // A swap that is turned off should not keep showing a stale score.
  useEffect(() => {
    if (settings.mode === "none" || !settings.bibleFile) {
      analysisSequence.current++
      setReport(null)
      setAnalyzeError(null)
      setAnalyzing(false)
    }
  }, [settings.mode, settings.bibleFile])

  const selectBible = (file: File | null) => {
    onChange({ ...settings, bibleFile: file })
    if (file && settings.mode !== "none") void runAnalysis(file)
  }

  const selectMode = (mode: BibleSwapSelection) => {
    onChange({ ...settings, mode })
    if (mode !== "none" && settings.bibleFile) void runAnalysis(settings.bibleFile)
  }

  const swapEnabled = settings.mode !== "none"
  const missingBible = swapEnabled && !settings.bibleFile

  const modeOptions: Array<{ id: BibleSwapSelection; label: string; description?: string }> = [
    { id: "none", label: t("importExport.bibleSwap.modeNone") },
    {
      id: "surgical",
      label: t("importExport.bibleSwap.modeSurgical"),
      description: t("importExport.bibleSwap.modeSurgicalDescription"),
    },
    {
      id: "structure",
      label: t("importExport.bibleSwap.modeStructure"),
      description: t("importExport.bibleSwap.modeStructureDescription"),
    },
  ]

  return (
    <fieldset className="flex flex-col gap-1.5 min-w-0" disabled={disabled}>
      <legend className="text-xs font-medium text-muted-foreground mb-1.5">
        {t("importExport.bibleSwap.legend")}
      </legend>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {t("importExport.bibleSwap.intro")}
      </p>

      <RadioGroup
        value={settings.mode}
        onValueChange={(value) => selectMode(value as BibleSwapSelection)}
        className="flex flex-col gap-0.5 mt-1.5"
        aria-label={t("importExport.bibleSwap.modeGroupAriaLabel")}
      >
        {modeOptions.map((option) => (
          <label
            key={option.id}
            className={
              "flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors " +
              (settings.mode === option.id
                ? "bg-accent/60 ring-1 ring-ring/20"
                : "hover:bg-accent/40")
            }
          >
            <RadioGroupItem value={option.id} className="mt-0.5 shrink-0" />
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium leading-tight">{option.label}</span>
              {option.description && (
                <span className="text-xs text-muted-foreground leading-relaxed">
                  {option.description}
                </span>
              )}
            </span>
          </label>
        ))}
      </RadioGroup>

      {swapEnabled && (
        <>
          <div className="mt-1.5 flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("importExport.bibleSwap.languageLegend")}
            </span>
            <Select
              value={settings.language}
              onValueChange={(value) => onChange({ ...settings, language: String(value) })}
            >
              <SelectTrigger
                size="sm"
                className="self-start min-w-56"
                aria-label={t("importExport.bibleSwap.languageAriaLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BIBLE_SWAP_LANGUAGES.map((language) => (
                  <SelectItem key={language.id} value={language.id}>
                    {language.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              {BIBLE_SWAP_LANGUAGES.find((l) => l.id === settings.language)?.description}
            </p>
          </div>

          <div className="mt-1.5 flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("importExport.bibleSwap.fileLegend")}
            </span>
            {settings.bibleFile ? (
              <div className="flex items-center gap-2 rounded-xl border px-2.5 py-2 self-start min-w-0">
                <FileArchive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex flex-col min-w-0">
                  <span className="text-sm truncate">{settings.bibleFile.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatBytes(settings.bibleFile.size)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  aria-label={t("importExport.bibleSwap.removeBible")}
                  onClick={() => selectBible(null)}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<label className="self-start" />}
              >
                <Book className="size-4" aria-hidden />
                {t("importExport.bibleSwap.chooseBible")}
                <input
                  type="file"
                  className="hidden"
                  accept=".idml,.IDML"
                  onChange={(e) => selectBible(e.target.files?.[0] ?? null)}
                />
              </Button>
            )}
            <p className="text-[10px] text-muted-foreground">
              {t("importExport.bibleSwap.fileHint")}
            </p>
            {missingBible && (
              <p role="alert" className="text-[10px] text-amber-600 dark:text-amber-400">
                {t("importExport.bibleSwap.missingBible")}
              </p>
            )}
          </div>

          {analyzing && (
            <p role="status" className="text-xs text-muted-foreground mt-1.5">
              {t("importExport.bibleSwap.analyzing")}
            </p>
          )}

          {analyzeError && (
            <p role="alert" className="text-xs text-amber-600 dark:text-amber-400 mt-1.5">
              {t("importExport.bibleSwap.analyzeFailed", { reason: analyzeError })}
            </p>
          )}

          {report && <CompatibilitySummary report={report} />}

          <details className="mt-1.5">
            <summary className="text-xs text-muted-foreground cursor-pointer">
              {t("importExport.bibleSwap.whatGetsSwapped")}
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5 text-[10px] text-muted-foreground leading-relaxed list-disc pl-4">
              <li>{t("importExport.bibleSwap.swappedItem")}</li>
              <li>{t("importExport.bibleSwap.notSwappedItem")}</li>
              <li>{t("importExport.bibleSwap.psalmsItem")}</li>
            </ul>
          </details>
        </>
      )}
    </fieldset>
  )
}

function CompatibilitySummary({ report }: { report: BibleSwapCompatibilityReport }) {
  const t = useT()
  const plan = report.versificationPlan

  return (
    <div role="status" className="mt-1.5 flex flex-col gap-0.5 rounded-xl bg-accent/40 px-2.5 py-2">
      <span className="text-xs font-medium">{t("importExport.bibleSwap.compatibilityLegend")}</span>
      <span className="text-[10px] text-muted-foreground">
        {t("importExport.bibleSwap.booksMatched", {
          found: formatNumber(report.booksFound),
          expected: formatNumber(report.booksExpected),
        })}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {t("importExport.bibleSwap.chaptersMatched", {
          found: formatNumber(report.chaptersFound),
          expected: formatNumber(report.chaptersExpected),
        })}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {t("importExport.bibleSwap.versesMatched", {
          found: formatNumber(report.versesMatched),
          expected: formatNumber(report.versesExpected),
        })}
      </span>
      {plan && (
        <>
          <span className="text-[10px] text-muted-foreground">
            {t("importExport.bibleSwap.projectedMatch", {
              percent: formatNumber(plan.projectedVerseMatchPercent),
            })}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {t("importExport.bibleSwap.planSummary", {
              mapped: formatNumber(plan.versesMapped),
              removed: formatNumber(plan.versesRemoved),
              inserted: formatNumber(plan.versesInserted),
            })}
          </span>
        </>
      )}
      {report.hasPsalms && (
        <span className="text-[10px] text-muted-foreground">
          {t("importExport.bibleSwap.psalmsNote")}
        </span>
      )}
      {report.perBookMismatches.length > 0 && (
        <>
          <span className="text-[10px] font-medium mt-0.5">
            {t("importExport.bibleSwap.worstBooks")}
          </span>
          {report.perBookMismatches.slice(0, 5).map((mismatch) => (
            <span key={mismatch.book} className="text-[10px] text-muted-foreground">
              {t("importExport.bibleSwap.bookMismatch", {
                book: mismatch.book,
                missing: formatNumber(mismatch.missing),
                extra: formatNumber(mismatch.extra),
              })}
            </span>
          ))}
        </>
      )}
    </div>
  )
}