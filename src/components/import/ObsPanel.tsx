import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { importObs, type EBibleProgress } from "@/lib/import"
import { formatBytesProgress as formatProgress } from "@/lib/format-bytes"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import type { FileReference } from "@/lib/parsers/types"

interface ObsPanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference, inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }) => void | Promise<void>
}

export function ObsPanel({ projectId, username, sourceLanguage, targetLanguage, getToken, onImported }: ObsPanelProps) {
  const { locale } = useI18n()
  const [progress, setProgress] = useState<EBibleProgress | null>(null)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Cancel any in-flight download when panel unmounts (e.g. dialog closed)
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  async function handleImport() {
    if (importing) return
    setImporting(true)
    setImportErr(null)
    setProgress({ phase: "download", received: 0, total: 0 })
    abortRef.current = new AbortController()

    try {
      // Mirrors importEBible's call: same ImportContext, progress, and signal.
      const ref = await importObs(
        {
          projectId,
          author: username,
          sourceLanguage,
          targetLanguage,
          getToken,
        },
        undefined,
        setProgress,
        abortRef.current.signal,
      )
      // English OBS — seed the project source language when unset.
      await onImported(ref, { sourceLanguage: "en" })
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImporting(false)
      abortRef.current = null
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Narrative stories with reference images, from{" "}
        <a href="https://git.door43.org/unfoldingWord/en_obs" target="_blank" rel="noreferrer" className="underline">
          unfoldingWord/door43
        </a>
        . 50 stories are imported as one source file; each frame becomes a cell
        carrying its reference image.
      </p>

      {progress && (
        <div className="text-xs text-muted-foreground">
          <p>
            {progress.phase === "download"
              ? `Downloading stories… ${formatProgress(progress.received, progress.total, locale)}`
              : progress.phase === "parse"
                ? "Parsing frames…"
                : progress.cellsTotal
                  ? `Uploading frames: ${formatNumber(progress.cellsEnqueued ?? 0, locale)} / ${formatNumber(progress.cellsTotal, locale)}`
                  : "Uploading to project…"}
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

      {importErr && <p className="text-sm text-destructive">{importErr}</p>}

      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={importing}>
          {importing ? "Importing…" : "Download & Import"}
        </Button>
      </div>
    </div>
  )
}
