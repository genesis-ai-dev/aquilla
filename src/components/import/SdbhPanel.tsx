import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { importSdbh, SdbhImportCancelledError, type SdbhImportProgress } from "@/lib/import-sdbh"
import { SDBH_MAX_REFERENCES, type SdbhNotImportedField } from "@/lib/parsers/sdbh"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import { RichMessage } from "@/lib/i18n/RichMessage"
import type { FileReference } from "@/lib/parsers/types"

interface SdbhPanelProps {
  projectId: string
  username: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (
    refs: FileReference[],
    inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string },
    skipped?: { book: string; reason: string }[],
  ) => void | Promise<void>
}

export function SdbhPanel({ projectId, username, getToken, onImported }: SdbhPanelProps) {
  const { locale } = useI18n()
  const t = useT()
  const [masterFile, setMasterFile] = useState<File | null>(null)
  const [localizedFile, setLocalizedFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<SdbhImportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notImported, setNotImported] = useState<SdbhNotImportedField[] | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const decisionRef = useRef<((proceed: boolean) => void) | null>(null)

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      decisionRef.current?.(false)
    }
  }, [])

  function decide(proceed: boolean) {
    decisionRef.current?.(proceed)
    decisionRef.current = null
    setNotImported(null)
  }

  async function handleImport() {
    if (!masterFile || importing) return
    setImporting(true)
    setError(null)
    setProgress({ phase: "parse" })
    abortRef.current = new AbortController()
    try {
      assertSourceUploadByteLength(masterFile.size)
      if (localizedFile) assertSourceUploadByteLength(localizedFile.size)
      const masterJson = await masterFile.text()
      const localizedJson = localizedFile ? await localizedFile.text() : null
      const summary = await importSdbh(
        masterJson,
        localizedJson,
        { projectId, author: username, getToken, signal: abortRef.current.signal },
        setProgress,
        {
          master: { name: masterFile.name, bytes: await masterFile.arrayBuffer() },
          ...(localizedFile ? {
            localized: { name: localizedFile.name, bytes: await localizedFile.arrayBuffer() },
          } : {}),
        },
        {
          confirmNotImported: (fields) =>
            new Promise<boolean>((resolve) => {
              decisionRef.current = resolve
              setNotImported(fields)
            }),
        },
      )
      await onImported(summary.refs, {
        sourceLanguage: "hbo",
        ...(summary.targetLanguageCode ? { targetLanguage: summary.targetLanguageCode } : {}),
      }, summary.skipped)
    } catch (err) {
      if (!(err instanceof SdbhImportCancelledError)) {
        setError(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
      }
    } finally {
      setImporting(false)
      setProgress(null)
      abortRef.current = null
    }
  }

  const pct =
    progress?.cellsTotal && progress.cellsTotal > 0
      ? Math.round(((progress.cellsEnqueued ?? 0) / progress.cellsTotal) * 100)
      : 0

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-xs text-muted-foreground">
        <RichMessage
          k="importExport.sdbh.description"
          values={{
            dictName: <span className="font-medium">{t("importExport.sdbh.dictionaryName")}</span>,
            masterFile: <code>SDBH-en.JSON</code>,
            localizedFile: <code>SDBH-es.JSON</code>,
          }}
        />
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<label />}>
          {masterFile ? masterFile.name : t("importExport.sdbh.chooseMaster")}
          <input
            type="file"
            className="hidden"
            accept=".json,.JSON"
            onChange={(e) => {
              setMasterFile(e.target.files?.[0] ?? null)
              setError(null)
            }}
            disabled={importing}
          />
        </Button>
        <Button variant="outline" size="sm" nativeButton={false} render={<label />}>
          {localizedFile ? localizedFile.name : t("importExport.sdbh.chooseLocalized")}
          <input
            type="file"
            className="hidden"
            accept=".json,.JSON"
            onChange={(e) => {
              setLocalizedFile(e.target.files?.[0] ?? null)
              setError(null)
            }}
            disabled={importing}
          />
        </Button>
      </div>
      {notImported && (
        <div role="alertdialog" aria-labelledby="sdbh-not-imported-title" className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <p id="sdbh-not-imported-title" className="font-medium">{t("importExport.sdbh.notImported.title")}</p>
          <p>
            {t("importExport.sdbh.notImported.body", {
              count: notImported.length,
              max: formatNumber(SDBH_MAX_REFERENCES, locale),
            })}
          </p>
          <ul className="list-disc pl-4">
            {notImported.slice(0, 5).map((f) => (
              <li key={f.conId}>
                {t("importExport.sdbh.notImported.item", { lemma: f.lemma, count: formatNumber(f.count, locale) })}
              </li>
            ))}
            {notImported.length > 5 && (
              <li>{t("importExport.sdbh.notImported.more", { count: notImported.length - 5 })}</li>
            )}
          </ul>
          <p className="text-muted-foreground">{t("importExport.sdbh.notImported.exportNote")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => decide(false)}>
              {t("importExport.sdbh.notImported.cancel")}
            </Button>
            <Button size="sm" onClick={() => decide(true)}>
              {t("importExport.sdbh.notImported.proceed")}
            </Button>
          </div>
        </div>
      )}
      {progress && !notImported && (
        <div className="text-xs text-muted-foreground">
          {progress.phase === "parse" ? (
            <p>{t("importExport.sdbh.parsingLexicon")}</p>
          ) : (
            <>
              <p>
                {progress.phase === "source"
                  ? t("importExport.sdbh.uploadingSource")
                  : t("importExport.sdbh.prefillingTranslations")}
                {progress.fileIndex
                  ? ` — ${t("importExport.sdbh.fileProgress", { index: progress.fileIndex, count: progress.fileCount ?? 0 })}`
                  : ""}
                {progress.cellsTotal
                  ? `: ${t("importExport.sdbh.cellsProgress", {
                      enqueued: formatNumber(progress.cellsEnqueued ?? 0, locale),
                      total: formatNumber(progress.cellsTotal, locale),
                    })}`
                  : ""}
              </p>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={!masterFile || importing}>
          {importing ? t("importExport.action.importing") : t("nav.workspaceActions.import")}
        </Button>
      </div>
    </div>
  )
}
