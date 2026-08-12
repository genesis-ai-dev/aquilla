import { useEffect, useMemo, useRef, useState } from "react"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { importEBible, prepareEBibleTargetImport, applyEBibleTargetImport, type EBibleProgress, type EBibleTargetProgress, type EBibleMatchResult, type SourceCellRef } from "@/lib/import"
import { formatBytesProgress as formatProgress } from "@/lib/format-bytes"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import { RichMessage } from "@/lib/i18n/RichMessage"
import type { FileReference } from "@/lib/parsers/types"
import { fetchTranslationsList, type EBibleTranslation } from "@/lib/parsers/ebible"
import { EBibleTargetReviewPanel } from "@/components/EBibleTargetReviewPanel"

interface EBiblePanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  targetLang?: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference, inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }) => void | Promise<void>
  /** When provided, enables the "into target" mode toggle (AQU-191). */
  sourceCells?: SourceCellRef[]
  /** Called after a successful target-column import (no new FileReference). */
  onTargetImported?: () => void
}

type EBiblePanelMode = "source" | "target"
type EBibleTargetStep = "pick" | "review" | "applying" | "done"

export function EBiblePanel({ projectId, username, sourceLanguage, targetLanguage, targetLang, getToken, sourceCells, onImported, onTargetImported }: EBiblePanelProps) {
  const { locale } = useI18n()
  const t = useT()
  const [mode, setMode] = useState<EBiblePanelMode>("source")
  const [targetStep, setTargetStep] = useState<EBibleTargetStep>("pick")
  const [matchResult, setMatchResult] = useState<EBibleMatchResult | null>(null)
  const [targetProgress, setTargetProgress] = useState<EBibleTargetProgress | null>(null)
  const [targetErr, setTargetErr] = useState<string | null>(null)

  const [translations, setTranslations] = useState<EBibleTranslation[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<EBibleTranslation | null>(null)
  const [progress, setProgress] = useState<EBibleProgress | null>(null)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Load on first mount
  useEffect(() => {
    let cancelled = false
    fetchTranslationsList()
      .then((list) => {
        if (!cancelled) setTranslations(list)
      })
      .catch((err) => {
        if (!cancelled) setLoadErr(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    if (!translations) return []
    const q = query.trim().toLowerCase()
    if (!q) return translations.slice(0, 200)
    return translations
      .filter(
        (tr) =>
          tr.id.toLowerCase().includes(q) ||
          tr.title.toLowerCase().includes(q) ||
          tr.languageNameInEnglish.toLowerCase().includes(q) ||
          tr.languageName.toLowerCase().includes(q)
      )
      .slice(0, 200)
  }, [translations, query])

  async function handleImport() {
    if (!selected || importing) return
    setImporting(true)
    setImportErr(null)
    setProgress({ phase: "download", received: 0, total: 0 })
    abortRef.current = new AbortController()

    try {
      const ref = await importEBible(
        selected,
        {
          projectId,
          author: username,
          sourceLanguage,
          targetLanguage,
          getToken,
        },
        setProgress,
        abortRef.current.signal
      )
      // Propagate the eBible translation's language code as the inferred
      // sourceLanguage so the project can seed it when unset (AQU-249).
      await onImported(ref, { sourceLanguage: selected.languageCode || selected.id })
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
    } finally {
      setImporting(false)
      abortRef.current = null
    }
  }

  // Cancel any in-flight download when panel unmounts (e.g. dialog closed)
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // ---------------------------------------------------------------------------
  // Target-import handlers (AQU-191)
  // ---------------------------------------------------------------------------

  async function handlePrepareTarget() {
    if (!selected || !sourceCells || importing) return
    setImporting(true)
    setTargetErr(null)
    setTargetProgress({ phase: "download", received: 0, total: 0 })
    abortRef.current = new AbortController()
    try {
      const result = await prepareEBibleTargetImport(
        selected,
        sourceCells,
        setTargetProgress,
        abortRef.current.signal,
      )
      setMatchResult(result)
      setTargetStep("review")
    } catch (err) {
      setTargetErr(err instanceof Error ? err.message : t("importExport.ebible.preparationFailed"))
    } finally {
      setImporting(false)
      abortRef.current = null
    }
  }

  async function handleApplyTarget(selectedCellIds: Set<string>) {
    if (!matchResult || !selected) return
    setTargetStep("applying")
    setTargetErr(null)
    try {
      await applyEBibleTargetImport(
        matchResult,
        selectedCellIds,
        { projectId, author: username, getToken, targetLang },
        setTargetProgress,
      )
      setTargetStep("done")
    } catch (err) {
      setTargetErr(err instanceof Error ? err.message : t("importExport.ebible.applyFailed"))
      setTargetStep("review")
    }
  }

  // ── Target: "applying" spinner ──────────────────────────────────────────────
  if (mode === "target" && targetStep === "applying") {
    return (
      <div className="mx-auto w-full max-w-sm py-8 text-center">
        <p className="text-sm font-medium">
          {targetProgress?.phase === "save" && targetProgress.cellsTotal
            ? t("importExport.ebible.committingVerses", {
                enqueued: formatNumber(targetProgress.cellsEnqueued ?? 0, locale),
                total: formatNumber(targetProgress.cellsTotal, locale),
              })
            : t("importExport.ebible.committingVersesIndeterminate")}
        </p>
        {targetProgress?.phase === "save" && targetProgress.cellsTotal ? (
          <div className="mx-auto mt-3 h-2 w-full max-w-xs overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.round(((targetProgress.cellsEnqueued ?? 0) / targetProgress.cellsTotal) * 100)}%` }}
            />
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">{t("importExport.action.working")}</p>
        )}
      </div>
    )
  }

  // ── Target: "done" confirmation ─────────────────────────────────────────────
  if (mode === "target" && targetStep === "done") {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <p className="text-sm font-medium">{t("importExport.ebible.targetCommitted")}</p>
        <p className="text-xs text-muted-foreground">
          {t("importExport.ebible.targetCommittedHint")}
        </p>
        <Button size="sm" onClick={() => onTargetImported?.()}>{t("common.close")}</Button>
      </div>
    )
  }

  // ── Target: "review" step ──────────────────────────────────────────────────
  if (mode === "target" && targetStep === "review" && matchResult && selected) {
    return (
      <EBibleTargetReviewPanel
        translation={selected}
        matchResult={matchResult}
        onApply={handleApplyTarget}
        onCancel={() => {
          setTargetStep("pick")
          setMatchResult(null)
        }}
      />
    )
  }

  // ── Shared translation picker ────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* Mode toggle — only shown when target-import is possible */}
      {sourceCells && sourceCells.length > 0 && (
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as EBiblePanelMode)}
          className="gap-0"
        >
          <TabsList size="lg" className="w-full" aria-label={t("importExport.ebible.modeTabsAriaLabel")}>
            <TabsTrigger value="source">{t("importExport.ebible.modeSource")}</TabsTrigger>
            <TabsTrigger value="target">{t("importExport.ebible.modeTarget")}</TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      <p className="text-xs text-muted-foreground">
        {mode === "source" ? (
          <RichMessage
            k="importExport.ebible.sourceDescription"
            values={{
              link: (
                <a href="https://github.com/BibleNLP/ebible" target="_blank" rel="noreferrer" className="underline">
                  {t("importExport.ebible.corpusLinkText")}
                </a>
              ),
            }}
          />
        ) : (
          t("importExport.ebible.targetDescription")
        )}
      </p>

      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder={t("importExport.ebible.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!translations || importing}
          aria-label={t("importExport.ebible.searchAriaLabel")}
        />
      </InputGroup>

      {loadErr ? (
        <p className="text-sm text-destructive">{t("importExport.helloao.failedToLoadList", { error: loadErr })}</p>
      ) : !translations ? (
        <p className="text-sm text-muted-foreground">{t("importExport.helloao.loadingTranslations")}</p>
      ) : (
        <ScrollArea className="h-72 rounded-md border">
          <ul className="divide-y">
            {filtered.length === 0 && (
              <li className="p-3 text-sm text-muted-foreground">{t("common.noMatches")}</li>
            )}
            {filtered.map((tr) => {
              const isSelected = selected?.id === tr.id
              return (
                <li key={tr.id}>
                  <button
                    type="button"
                    disabled={importing}
                    onClick={() => setSelected(tr)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-start text-sm transition-colors hover:bg-accent",
                      isSelected && "bg-accent"
                    )}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="font-medium">{tr.title}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {tr.id}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {tr.languageNameInEnglish || tr.languageName}
                      {tr.otBooks + tr.ntBooks > 0 && (
                        <> · {t("importExport.ebible.otBooks", { count: tr.otBooks })} · {t("importExport.ebible.ntBooks", { count: tr.ntBooks })}</>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}

      {selected && (
        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <div className="font-medium text-sm">{selected.title}</div>
          <div className="text-muted-foreground">{selected.copyright || t("importExport.ebible.noCopyrightInfo")}</div>
        </div>
      )}

      {/* Source mode: show source-upload progress */}
      {mode === "source" && progress && (
        <div className="text-xs text-muted-foreground">
          <p>
            {progress.phase === "download"
              ? t("importExport.ebible.downloading", {
                  id: selected?.id ?? "",
                  progress: formatProgress(progress.received, progress.total, locale),
                })
              : progress.phase === "parse"
                ? t("importExport.helloao.parsingVerses")
                : progress.cellsTotal
                  ? t("importExport.helloao.uploadingVerses", {
                      enqueued: formatNumber(progress.cellsEnqueued ?? 0, locale),
                      total: formatNumber(progress.cellsTotal, locale),
                    })
                  : t("importExport.obs.uploadingToProject")}
          </p>
          {progress.phase === "save" && progress.cellsTotal ? (
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{
                  width: `${Math.round(((progress.cellsEnqueued ?? 0) / progress.cellsTotal) * 100)}%`,
                }}
              />
            </div>
          ) : null}
        </div>
      )}

      {/* Target mode: show prepare-step progress */}
      {mode === "target" && targetProgress && (
        <div className="text-xs text-muted-foreground">
          <p>
            {targetProgress.phase === "download"
              ? t("importExport.ebible.downloading", {
                  id: selected?.id ?? "",
                  progress: formatProgress(targetProgress.received, targetProgress.total, locale),
                })
              : targetProgress.phase === "parse"
                ? t("importExport.helloao.parsingVerses")
                : t("importExport.ebible.matchingVerses")}
          </p>
        </div>
      )}

      {importErr && <p className="text-sm text-destructive">{importErr}</p>}
      {targetErr && <p className="text-sm text-destructive">{targetErr}</p>}

      <div className="flex justify-end">
        {mode === "source" ? (
          <Button onClick={handleImport} disabled={!selected || importing}>
            {importing ? t("importExport.action.importing") : t("importExport.action.import")}
          </Button>
        ) : (
          <Button onClick={handlePrepareTarget} disabled={!selected || importing || !sourceCells?.length}>
            {importing ? t("importExport.ebible.preparing") : t("importExport.ebible.nextReviewMatches")}
          </Button>
        )}
      </div>
    </div>
  )
}
