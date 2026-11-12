// AQU-1392: the volume-analysis report surface.
//
// The dialog owns the run, not the caller, for one reason: the run is long
// (a whole-Bible project walks every file over the network) and its lifetime
// is exactly the dialog's. Closing the dialog aborts it; nothing outside here
// has to remember that.
//
// Reads follow AD-3's thin-client rule — plain `useState` plus a race-guarded
// `useEffect` keyed on an AbortController, no React Query.

import { useCallback, useEffect, useRef, useState } from "react"
import { Download, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { analysisCsvFilename, analysisReportToCsv, bandLabel } from "@/lib/analysis/analysis-csv"
import type { AnalysisReport } from "@/lib/analysis/report"
import { runAnalysis, type AnalyzableFile, type RunAnalysisProgress } from "@/lib/analysis/run-analysis"
import { useT } from "@/lib/i18n/I18nProvider"

export interface AnalysisReportDialogProps {
  open: boolean
  onClose: () => void
  scope: "file" | "project"
  /** File name or project name — what the report is of. */
  label: string
  files: readonly AnalyzableFile[]
  loadSources: (file: AnalyzableFile) => Promise<readonly string[]>
  /** Seam for tests; defaults to an anchor-click download. */
  onDownload?: (csv: string, filename: string) => void
}

function downloadCsv(csv: string, filename: string): void {
  // A BOM so Excel opens a UTF-8 CSV with CJK/Burmese file names intact.
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const nf = (n: number): string => new Intl.NumberFormat().format(n)

export function AnalysisReportDialog({
  open,
  onClose,
  scope,
  label,
  files,
  loadSources,
  onDownload = downloadCsv,
}: AnalysisReportDialogProps) {
  const t = useT()
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [progress, setProgress] = useState<RunAnalysisProgress | null>(null)
  const [skipped, setSkipped] = useState<{ fileId: string; name: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  // `loadSources` is typically an inline closure, so keeping it in a ref stops
  // a parent re-render from restarting a run that is already half done.
  const loadRef = useRef(loadSources)
  loadRef.current = loadSources

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setReport(null)
    setSkipped([])
    setError(null)
    setProgress(null)
    setRunning(true)

    void runAnalysis({
      files,
      loadSources: (f) => loadRef.current(f),
      scope,
      label,
      signal: controller.signal,
      onProgress: (p) => {
        if (!controller.signal.aborted) setProgress(p)
      },
    })
      .then((result) => {
        if (controller.signal.aborted) return
        setReport(result.report)
        setSkipped(result.skipped.map(({ fileId, name }) => ({ fileId, name })))
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setRunning(false)
      })

    return () => controller.abort()
  }, [open, files, scope, label])

  const handleDownload = useCallback(() => {
    if (!report) return
    onDownload(analysisReportToCsv(report), analysisCsvFilename(report.label))
  }, [report, onDownload])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-2xl" data-testid="analysis-report-dialog">
        <DialogHeader>
          <DialogTitle>{t("workspace.analysis.title", { label })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {running && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              {progress
                ? t("workspace.analysis.progress", {
                    done: String(progress.done),
                    total: String(progress.total),
                  })
                : t("workspace.analysis.starting")}
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {report && (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("workspace.analysis.col.band")}</TableHead>
                    <TableHead className="text-right">{t("workspace.analysis.col.segments")}</TableHead>
                    <TableHead className="text-right">{t("workspace.analysis.col.words")}</TableHead>
                    <TableHead className="text-right">{t("workspace.analysis.col.pct")}</TableHead>
                    <TableHead className="text-right">{t("workspace.analysis.col.rate")}</TableHead>
                    <TableHead className="text-right">{t("workspace.analysis.col.weighted")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.bands.map((b) => (
                    <TableRow key={b.band} data-testid={`analysis-band-${b.band}`} className={b.unpopulated ? "text-muted-foreground" : undefined}>
                      <TableCell>{bandLabel(b.band)}</TableCell>
                      <TableCell className="text-right tabular-nums">{nf(b.segments)}</TableCell>
                      <TableCell className="text-right tabular-nums">{nf(b.words)}</TableCell>
                      <TableCell className="text-right tabular-nums">{b.pctOfWords}%</TableCell>
                      <TableCell className="text-right tabular-nums">{Math.round(b.rate * 100)}%</TableCell>
                      <TableCell className="text-right tabular-nums">{nf(b.payableWords)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <dt className="text-muted-foreground">{t("workspace.analysis.totalSegments")}</dt>
                <dd className="tabular-nums" data-testid="analysis-total-segments">{nf(report.totalSegments)}</dd>
                <dt className="text-muted-foreground">{t("workspace.analysis.totalWords")}</dt>
                <dd className="tabular-nums" data-testid="analysis-total-words">{nf(report.totalWords)}</dd>
                <dt className="text-muted-foreground">{t("workspace.analysis.weightedWords")}</dt>
                <dd className="font-medium tabular-nums" data-testid="analysis-weighted-words">{nf(report.payableWords)}</dd>
                <dt className="text-muted-foreground">{t("workspace.analysis.saving")}</dt>
                <dd className="tabular-nums" data-testid="analysis-saving">{report.discountPct}%</dd>
              </dl>

              <p className="mt-4 text-xs text-muted-foreground">{t("workspace.analysis.unpopulatedNote")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("workspace.analysis.ratesNote")}</p>

              {skipped.length > 0 && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" data-testid="analysis-skipped">
                  {t("workspace.analysis.skipped", { names: skipped.map((s) => s.name).join(", ") })}
                </p>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button onClick={handleDownload} disabled={!report}>
            <Download className="size-4" aria-hidden />
            {t("workspace.analysis.exportCsv")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
