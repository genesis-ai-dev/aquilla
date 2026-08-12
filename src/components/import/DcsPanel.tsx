import { useCallback, useEffect, useRef, useState } from "react"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import type { FileReference } from "@/lib/parsers/types"
import { DcsCatalogBrowser } from "@/components/dcs/DcsCatalogBrowser"
import { importDcsResource } from "@/lib/dcs/import-dcs"
import { DcsClient } from "@/lib/dcs/catalog"
import type { DcsCatalogEntry, DcsCursor } from "@/lib/dcs/types"

interface DcsPanelProps {
  projectId: string
  getToken: (fileId: string) => Promise<string | null>
  defaultLang?: string
  /** Persist the pinned-release cursor to the project settings. Returns true on save. */
  patchDcsCursor: (cursor: DcsCursor) => Promise<boolean>
  /** Signal the parent to refresh after a successful or partial import. */
  onImported: (
    refs: FileReference[],
    inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string },
    skipped?: { book: string; reason: string }[],
  ) => void | Promise<void>
  /** AQU-634: per-project USFM front-matter opt-out (forwarded to
   *  importDcsResource). */
  excludeFrontMatter?: boolean
}

type DcsPanelStage = "browse" | "importing" | "done"

export function DcsPanel({ projectId, getToken, defaultLang, patchDcsCursor, onImported, excludeFrontMatter }: DcsPanelProps) {
  const { locale } = useI18n()
  const [stage, setStage] = useState<DcsPanelStage>("browse")
  const [selected, setSelected] = useState<DcsCatalogEntry | null>(null)
  const [progress, setProgress] = useState<{ uploaded: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<{ files: number; cells: number; ref: string; pinned: boolean } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Cancel any in-flight import when the panel unmounts (dialog closed).
  useEffect(() => () => abortRef.current?.abort(), [])

  const runImport = useCallback(async (entry: DcsCatalogEntry) => {
    setSelected(entry)
    setStage("importing")
    setError(null)
    setProgress(null)
    abortRef.current = new AbortController()
    try {
      const result = await importDcsResource({
        entry,
        projectId,
        client: new DcsClient(),
        getToken,
        trackMode: "release",
        excludeFrontMatter,
        onProgress: (uploaded, total) => setProgress({ uploaded, total }),
        signal: abortRef.current.signal,
      })
      // Pin the project to the imported release (spec §8). A failed patch is
      // surfaced but does NOT undo the source cells that already landed.
      let pinned = false
      try {
        pinned = await patchDcsCursor(result.cursor)
      } catch (err) {
        console.warn("[DcsPanel] failed to persist dcsUpstream cursor:", err)
      }
      setSummary({ files: result.files, cells: result.cells, ref: result.cursor.ref, pinned })
      setStage("done")
      // Refresh the project and retain a per-file report if only part landed.
      await onImported(
        result.refs,
        entry.language ? { sourceLanguage: entry.language } : undefined,
        result.skipped,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed")
      setStage("browse")
    } finally {
      abortRef.current = null
    }
  }, [projectId, getToken, patchDcsCursor, onImported, excludeFrontMatter])

  if (stage === "browse") {
    return (
      <div className="flex flex-col gap-2">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DcsCatalogBrowser
          onPick={(entry) => void runImport(entry)}
          {...(defaultLang ? { defaultLang } : {})}
        />
      </div>
    )
  }

  if (stage === "importing") {
    const pct = progress && progress.total > 0
      ? Math.round((progress.uploaded / progress.total) * 100)
      : 0
    return (
      <div className="mx-auto w-full max-w-sm py-8 text-center">
        <p className="text-sm font-medium">
          Importing {selected?.fullName ?? "resource"}
          {selected?.ref ? ` @ ${selected.ref}` : ""}…
        </p>
        {progress && progress.total > 0 ? (
          <>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {formatNumber(progress.uploaded, locale)} / {formatNumber(progress.total, locale)} files
            </p>
          </>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Fetching &amp; parsing from Door43…</p>
        )}
      </div>
    )
  }

  // stage === "done"
  return (
    <div className="mx-auto w-full max-w-sm py-8 text-center">
      <p className="text-sm font-medium">Import complete</p>
      {summary && (
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p>{selected?.fullName}</p>
          <p>
            {formatNumber(summary.files, locale)} file{summary.files === 1 ? "" : "s"} ·{" "}
            {formatNumber(summary.cells, locale)} cell{summary.cells === 1 ? "" : "s"}
          </p>
          <p>
            {summary.pinned
              ? <>Pinned to release <span className="font-medium text-foreground/80">{summary.ref}</span></>
              : <span className="text-amber-600 dark:text-amber-400">
                  Imported, but couldn&apos;t pin the release — you may lack maintainer rights on this project.
                </span>}
          </p>
        </div>
      )}
    </div>
  )
}
