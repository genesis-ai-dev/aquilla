import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { importSdbh, type SdbhImportProgress } from "@/lib/import-sdbh"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
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
  const [masterFile, setMasterFile] = useState<File | null>(null)
  const [localizedFile, setLocalizedFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<SdbhImportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

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
      )
      await onImported(summary.refs, {
        sourceLanguage: "hbo",
        ...(summary.targetLanguageCode ? { targetLanguage: summary.targetLanguageCode } : {}),
      }, summary.skipped)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed")
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
        Import the UBS MARBLE <span className="font-medium">Semantic Dictionary of Biblical Hebrew</span>.
        Choose the master edition (usually <code>SDBH-en.JSON</code>) as the source; optionally add a
        localized edition (e.g. <code>SDBH-es.JSON</code>) to pre-fill the target column with the
        translation so far. Entries import one file per Hebrew letter plus a semantic-domain label
        file; each sense groups as one paragraph with a cell per definition, gloss list, and comment.
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<label />}>
          {masterFile ? masterFile.name : "Choose master edition (SDBH-en.JSON)"}
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
          {localizedFile ? localizedFile.name : "Choose localized edition (optional)"}
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
      {progress && (
        <div className="text-xs text-muted-foreground">
          {progress.phase === "parse" ? (
            <p>Parsing lexicon…</p>
          ) : (
            <>
              <p>
                {progress.phase === "source" ? "Uploading source" : "Pre-filling translations"}
                {progress.fileIndex ? ` — file ${progress.fileIndex} / ${progress.fileCount}` : ""}
                {progress.cellsTotal
                  ? `: ${formatNumber(progress.cellsEnqueued ?? 0, locale)} / ${formatNumber(progress.cellsTotal, locale)} cells`
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
          {importing ? "Importing…" : "Import"}
        </Button>
      </div>
    </div>
  )
}
