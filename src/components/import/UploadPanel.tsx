import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { importFile, prepareImportFile, type ImportResult } from "@/lib/import"
import type { PreparedImportFile } from "@/lib/import/import-service"
import type { ImportUploadProgress } from "@/components/import/PreviewPanel"
import { ParatextChoice } from "./ParatextChoice"
import { formatBytesProgress } from "@/lib/format-bytes"
import { GoogleDrivePanel } from "@/components/import/GoogleDrivePanel"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { t as tStandalone } from "@/lib/i18n/standalone"
import { formatNumber } from "@/lib/i18n/format"
import type { FileReference, ProjectTtsSettings } from "@/lib/parsers/types"
import { detectFileType, isMediaFileType } from "@/lib/parsers/types"
import { buildCastAdditions } from "@/lib/import/cast-from-speakers"
import { v7 as uuidv7 } from "uuid"
import { filesToProjectEntries } from "@/lib/import/file-entries"
import { detectParatextProject, type ProjectEntry } from "@/lib/parsers/paratext-project"
import { detectCollisions, type CollisionResult } from "@/lib/import-collision"
import posthog from "@/lib/posthog"
import { IMPORT_FAILED } from "@/lib/event-names"
import type { CollisionResolution } from "./import-dialog-types"

interface UploadPanelProps {
  /**
   * AQU-823: "gdrive" swaps the dropzone for the Google Drive picker while
   * reusing this panel's whole state machine (importing, progress, error,
   * Paratext choice). Same file sink, different file source.
   */
  variant?: "upload" | "gdrive"
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  targetLang?: string
  identityToken?: string
  getToken: (fileId: string) => Promise<string | null>
  /** AQU-277: third argument carries skipped books for partial Paratext imports. */
  onImported: (refs: FileReference[], inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }, skipped?: { book: string; reason: string }[]) => void | Promise<void>
  ttsSettings?: ProjectTtsSettings
  onCastUpdated?: (settings: Partial<ProjectTtsSettings>) => void | Promise<void>
  /**
   * AQU-287: files already in the project. Passed to detectCollisions before
   * any import starts; on collision, onCollision is called instead of proceeding.
   */
  existingFiles?: { id?: string; name: string; bookCode?: string }[]
  /** AQU-287: called when collisions are detected; parent shows the collision screen. */
  onCollision?: (collisions: CollisionResult[], proceed: (resolution: CollisionResolution) => void | Promise<void>) => void
  /**
   * AQU-310: called after client-side parsing completes, before any upload.
   * Parent shows a preview screen; commit() triggers the actual bulk upload.
   */
  onPreview?: (results: ImportResult[], commit: () => Promise<void>) => void
  /**
   * AQU-430: callbacks for the parent to receive upload progress while the
   * preview screen is shown (UploadPanel is unmounted during preview). The
   * parent forwards these to PreviewPanel so an in-flight indicator is visible.
   */
  onCommitPhase?: (phase: string) => void
  onCommitProgress?: (progress: ImportUploadProgress | null) => void
  /** AQU-430 (fix): surface a commit failure to the parent so the unmounted
   *  UploadPanel's local error is still shown on the preview screen. */
  onCommitError?: (message: string | null) => void
  /** Spreadsheet-shaped files need explicit column mapping before preview.
   * Keep this handoff inside the unified Upload files entry point so users do
   * not have to know which specialized importer to choose. */
  onSpreadsheetFile: (file: File) => void
  /** AQU-634: per-project USFM front-matter opt-out (forwarded to parseFile /
   *  the Paratext preview). */
  excludeFrontMatter?: boolean
}

/** Sorted, deduped extension list ("mp3,usfm") for import telemetry breakdowns. */
function fileExts(list: File[]): string {
  return [...new Set(list.map((f) => f.name.split(".").pop()?.toLowerCase() ?? ""))].sort().join(",")
}

// Outside React render (called from a progress callback passed into a plain
// lib helper), so this uses the standalone t() rather than useT() — see
// src/lib/i18n/standalone.ts.
function idmlParsePhase(
  fileName: string,
  progress: { phase: string; completed: number; total: number },
): string {
  const actionKey =
    progress.phase === "inspect"
      ? "importExport.upload.idmlChecking"
      : progress.phase === "unpack"
        ? "importExport.upload.idmlOpening"
        : "importExport.upload.idmlReading"
  const count =
    progress.total > 1
      ? tStandalone("importExport.upload.idmlCountSuffix", {
          completed: Math.min(progress.completed, progress.total),
          total: progress.total,
        })
      : ""
  return tStandalone("importExport.upload.idmlPhase", {
    action: tStandalone(actionKey),
    fileName,
    count,
  })
}

export function UploadPanel({ variant = "upload", projectId, username, sourceLanguage, targetLanguage, targetLang, identityToken, getToken, onImported, ttsSettings, onCastUpdated, existingFiles, onCollision, onPreview, onCommitPhase, onCommitProgress, onCommitError, onSpreadsheetFile, excludeFrontMatter }: UploadPanelProps) {
  const { locale } = useI18n()
  const t = useT()
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string>("")
  const [progress, setProgress] = useState<ImportUploadProgress | null>(null)
  // AQU-823: file provenance from the Google Drive picker, stamped into the
  // import manifest at commit time. One-shot — see the finally below.
  const originsRef = useRef<Map<string, Record<string, unknown>> | null>(null)
  const parseAbortRef = useRef<AbortController | null>(null)
  const finalizationCheckpointRef = useRef<{
    files: File[]
    refs: FileReference[]
    skipped?: { book: string; reason: string }[]
  } | null>(null)
  useEffect(() => () => parseAbortRef.current?.abort(), [])
  // Set when a dropped/selected set is a Paratext project — we pause to ask
  // whether it's a source text or a translation-in-progress (target) before
  // importing.
  const [paratextChoice, setParatextChoice] = useState<{ entries: ProjectEntry[]; bookCount: number } | null>(null)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setError(null)
      const list = Array.from(files)
      // A Paratext project (zipped, or a folder/multi-select containing
      // Settings.xml) is imported as one unit — but first ask source vs target.
      const entries = await filesToProjectEntries(list)
      const detected = detectParatextProject(entries)
      if (detected) {
        setParatextChoice({ entries, bookCount: detected.sfmEntries.length })
        return
      }

      // AQU-287: single-file collision check before parsing/uploading.
      if (existingFiles && existingFiles.length > 0 && onCollision) {
        const incoming = list.map((f) => ({ name: f.name }))
        const collisions = detectCollisions(incoming, existingFiles)
        if (collisions.length > 0) {
          // Pause and ask the user; once resolved, re-run with a skipKeys set.
          onCollision(collisions, async (resolution) => {
            // Filter out skipped files and proceed with the rest.
            const filtered = list.filter((f) => !resolution.skipKeys.has(f.name.trim().toLowerCase()))
            if (filtered.length === 0) return
            await doImportFiles(filtered, resolution.reimportFileIds)
          })
          return
        }
      }

      await doImportFiles(list)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, username, sourceLanguage, targetLanguage, targetLang, identityToken, getToken, onImported, ttsSettings, onCastUpdated, existingFiles, onCollision, t]
  )

  /** Inner helper: import a resolved list of files (after collision resolution).
   *
   * AQU-310: when `onPreview` is provided, this splits into two phases:
   *   1. Parse phase — reads all files locally, shows a preview
   *   2. Commit phase — uploads after user confirms
   * Media files bypass preview (they have no text cells to show).
   */
  const doImportFiles = useCallback(
    async (list: File[], reimportFileIds?: ReadonlyMap<string, string>) => {
      const spreadsheets = list.filter((file) => /\.(?:csv|tsv|xlsx)$/i.test(file.name))
      if (spreadsheets.length > 0) {
        if (list.length !== 1) {
          setError(t("importExport.upload.oneSpreadsheetAtATime"))
          return
        }
        onSpreadsheetFile(spreadsheets[0])
        return
      }

      setImporting(true)
      setProgress(null)
      setError(null)

      // ── Phase 1: parse ────────────────────────────────────────────────────
      // Separate text files (previewable) from media files (upload directly).
      const textFiles: File[] = []
      const mediaFiles: File[] = []
      for (const file of list) {
        const ft = detectFileType(file.name)
        if (ft && isMediaFileType(ft)) {
          mediaFiles.push(file)
        } else {
          textFiles.push(file)
        }
      }

      // Parse text files client-side for the preview.
      const allParsedResults: ImportResult[] = []
      const preparedByFile = new Map<File, PreparedImportFile>()
      if (textFiles.length > 0 && onPreview) {
        parseAbortRef.current?.abort()
        const parseController = new AbortController()
        parseAbortRef.current = parseController
        try {
          for (const file of textFiles) {
            const knownType = detectFileType(file.name)
            setPhase(
              knownType
                ? t("importExport.upload.readingFile", { fileName: file.name })
                : t("importExport.upload.analyzingFile", { fileName: file.name }),
            )
            const prepared = await prepareImportFile(file, {
              projectId,
              identityToken,
              sourceLanguage,
              targetLanguage,
              signal: parseController.signal,
              onIdmlProgress: (progress) => {
                setPhase(idmlParsePhase(file.name, progress))
              },
              excludeFrontMatter,
            })
            preparedByFile.set(file, prepared)
            allParsedResults.push(...prepared.results)
          }
        } catch (err) {
          if (parseController.signal.aborted) return
          posthog.captureException(err, { import_stage: "parse", project_id: projectId, file_exts: fileExts(list) })
          posthog.capture(IMPORT_FAILED, {
            import_stage: "parse",
            project_id: projectId,
            file_exts: fileExts(list),
            error_message: err instanceof Error ? err.message : String(err),
          })
          setError(err instanceof Error ? err.message : t("importExport.upload.parseFailed"))
          setImporting(false)
          setPhase("")
          return
        } finally {
          if (parseAbortRef.current === parseController) parseAbortRef.current = null
        }
        setImporting(false)
        setPhase("")

        // Hand off to parent to show the preview screen.
        // The commit closure does the actual upload.
        onPreview(allParsedResults, async () => {
          await doCommit(list, preparedByFile, reimportFileIds)
        })
        return
      }

      // No preview (media-only batch, or no onPreview callback) — commit immediately.
      await doCommit(list, undefined, reimportFileIds)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, username, sourceLanguage, targetLanguage, identityToken, getToken, onImported, ttsSettings, onCastUpdated, onPreview, onSpreadsheetFile, t]
  )

  /** Upload all files (called after preview confirmation, or directly for media). */
  const doCommit = useCallback(
    async (
      list: File[],
      preparedByFile?: ReadonlyMap<File, PreparedImportFile>,
      reimportFileIds?: ReadonlyMap<string, string>,
    ) => {
      setImporting(true)
      setProgress(null)
      setPhase("")
      onCommitProgress?.(null)
      onCommitError?.(null)
      const checkpoint = finalizationCheckpointRef.current
      if (checkpoint?.files === list) {
        const finishPhase = t("importExport.upload.finishingUp")
        setPhase(finishPhase)
        onCommitPhase?.(finishPhase)
        try {
          await onImported(checkpoint.refs, undefined, checkpoint.skipped)
          finalizationCheckpointRef.current = null
        } catch (err) {
          const message = err instanceof Error ? err.message : t("importExport.upload.finalizationFailed")
          setError(message)
          onCommitError?.(message)
        } finally {
          setImporting(false)
          setProgress(null)
          onCommitProgress?.(null)
          setPhase("")
          onCommitPhase?.("")
        }
        return
      }
      const allRefs: FileReference[] = []
      const allSkipped: { book: string; reason: string }[] = []
      // Accumulate speaker pairs across all subtitle files in this batch.
      const allSpeakerPairs: { cellId: string; speaker: string | undefined }[] = []
      // AQU-520: byte totals so the progress UI can show "X / Y MB", not just a
      // cell count/percentage that "feels stalled" on large partner imports.
      // Totals come from the real File.size; within a file we scale by the cell
      // fraction. `bytesTotal === 0` (media with no size, etc.) hides the readout.
      const bytesTotal = list.reduce((sum, f) => sum + (f.size || 0), 0)
      let bytesBefore = 0
      let currentFileIndex = 0
      let castAttempted = false
      let handoffAttempted = false
      const persistCastAdditions = async () => {
        castAttempted = true
        if (onCastUpdated && allSpeakerPairs.some((p) => p.speaker)) {
          const additions = buildCastAdditions(allSpeakerPairs, ttsSettings, uuidv7)
          await onCastUpdated({
            voices: additions.voices,
            castAssignments: {
              ...(ttsSettings?.castAssignments ?? {}),
              ...additions.castAssignments,
            },
          })
        }
      }
      try {
        for (; currentFileIndex < list.length; currentFileIndex++) {
          const file = list[currentFileIndex]
          const filePhase = t("importExport.upload.uploadingFile", { fileName: file.name })
          setPhase(filePhase)
          // AQU-430: surface phase to parent so PreviewPanel can show progress.
          onCommitPhase?.(filePhase)
          setProgress(null)
          onCommitProgress?.(null)
          // importFile returns speakerPairs from the SAME buildBulkCellsWithSpeakers
          // call that minted the uploaded cells — cellIds are guaranteed to match.
          const { refs, speakerPairs, skipped } = await importFile(file, {
            projectId,
            author: username,
            sourceLanguage,
            targetLanguage,
            targetLang,
            identityToken,
            reimportFileIds,
            origins: originsRef.current ?? undefined,
            getToken,
            onCellEnqueued: (count, total) => {
              const p = t("importExport.upload.uploadingFile", { fileName: file.name })
              setPhase(p)
              onCommitPhase?.(p)
              const frac = total > 0 ? Math.min(count / total, 1) : 0
              const bytesReceived = bytesBefore + Math.round(frac * (file.size || 0))
              const next: ImportUploadProgress = { count, total, bytesReceived, bytesTotal }
              setProgress(next)
              onCommitProgress?.(next)
            },
          }, preparedByFile?.get(file))
          bytesBefore += file.size || 0
          allRefs.push(...refs)
          allSpeakerPairs.push(...speakerPairs)
          if (skipped) allSkipped.push(...skipped)
        }
        // Apply cast additions if any subtitle speakers were found.
        await persistCastAdditions()
        const finishPhase = t("importExport.upload.finishingUp")
        setPhase(finishPhase)
        onCommitPhase?.(finishPhase)
        handoffAttempted = true
        const skipped = allSkipped.length ? allSkipped : undefined
        finalizationCheckpointRef.current = { files: list, refs: allRefs, skipped }
        await onImported(allRefs, undefined, skipped)
        finalizationCheckpointRef.current = null
      } catch (err) {
        const message = err instanceof Error ? err.message : t("importExport.errors.importFailed")
        posthog.captureException(err, { import_stage: "upload", project_id: projectId, file_exts: fileExts(list) })
        posthog.capture(IMPORT_FAILED, {
          import_stage: "upload",
          project_id: projectId,
          file_exts: fileExts(list),
          error_message: message,
        })
        if (allRefs.length > 0 && !handoffAttempted) {
          const failedAndUnattempted = [
            ...allSkipped,
            ...list.slice(currentFileIndex).map((file, index) => ({
              book: file.name,
              reason: index === 0 ? message : t("importExport.upload.notAttempted"),
            })),
          ]
          // Speakers from files that did succeed must not disappear merely
          // because a later file failed. Report a cast write failure separately
          // from file failures instead of retrying the file publication.
          if (!castAttempted) {
            try {
              await persistCastAdditions()
            } catch (castError) {
              failedAndUnattempted.push({
                book: t("importExport.upload.castAssignmentsLabel"),
                reason: castError instanceof Error ? castError.message : String(castError),
              })
            }
          }
          if (failedAndUnattempted.length === 0) {
            failedAndUnattempted.push({ book: t("importExport.upload.importFinalizationLabel"), reason: message })
          }
          handoffAttempted = true
          finalizationCheckpointRef.current = {
            files: list,
            refs: allRefs,
            skipped: failedAndUnattempted,
          }
          try {
            await onImported(allRefs, undefined, failedAndUnattempted)
            finalizationCheckpointRef.current = null
          } catch (handoffError) {
            const handoffMessage = handoffError instanceof Error ? handoffError.message : t("importExport.upload.finalizationFailed")
            setError(handoffMessage)
            onCommitError?.(handoffMessage)
          }
        } else {
          setError(message)
          // AQU-430 (fix): also surface to the parent — during the preview screen
          // this UploadPanel is unmounted, so its local error would never show.
          onCommitError?.(message)
        }
      } finally {
        // AQU-823: one-shot Drive provenance — a later plain upload must not
        // inherit origins from a previous Google Drive batch.
        originsRef.current = null
        setImporting(false)
        setProgress(null)
        onCommitProgress?.(null)
        setPhase("")
        onCommitPhase?.("")
      }
    },
    [projectId, username, sourceLanguage, targetLanguage, targetLang, identityToken, getToken, onImported, ttsSettings, onCastUpdated, onCommitPhase, onCommitProgress, onCommitError, t]
  )

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files)
    }
  }

  if (paratextChoice) {
    return (
      <ParatextChoice
        entries={paratextChoice.entries}
        bookCount={paratextChoice.bookCount}
        projectId={projectId}
        username={username}
        sourceLanguage={sourceLanguage}
        targetLanguage={targetLanguage}
        targetLang={targetLang}
        getToken={getToken}
        onImported={onImported}
        onCancel={() => setParatextChoice(null)}
        existingFiles={existingFiles}
        onCollision={onCollision}
        excludeFrontMatter={excludeFrontMatter}
      />
    )
  }

  // AQU-823: Google Drive variant — same panel state machine (importing,
  // progress, error, Paratext choice above), different file source.
  if (variant === "gdrive" && !importing) {
    return (
      <div>
        <GoogleDrivePanel
          onFiles={async (files, origins) => {
            // Cleared in doCommit's finally — the preview flow commits later
            // from a closure, so clearing here would race the actual upload.
            originsRef.current = origins
            await handleFiles(files)
          }}
        />
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors",
        dragOver ? "border-primary bg-primary/5" : "border-muted"
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {importing ? (
        <div className="w-full max-w-sm text-center">
          <p className="text-sm font-medium">{phase || t("importExport.action.importing")}</p>
          {progress && progress.total > 0 ? (
            <>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((progress.count / progress.total) * 100)}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t("importExport.upload.cellsProgress", {
                  count: formatNumber(progress.count, locale),
                  total: formatNumber(progress.total, locale),
                })}
                {progress.bytesTotal ? (
                  <>
                    {" · "}
                    <span data-testid="upload-bytes">
                      {formatBytesProgress(progress.bytesReceived, progress.bytesTotal, locale)}
                    </span>
                  </>
                ) : null}
              </p>
            </>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">{t("importExport.action.working")}</p>
          )}
        </div>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            {t("importExport.upload.dragDropHint")}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" nativeButton={false} render={<label />}>
              {t("importExport.upload.chooseFiles")}
              <input
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInput}
              />
            </Button>
            <Button variant="outline" size="sm" nativeButton={false} render={<label />}>
              {t("importExport.upload.chooseFolder")}
              {/* Folder picker for an unzipped Paratext project. */}
              <input
                type="file"
                className="hidden"
                // @ts-expect-error — webkitdirectory is a non-standard but widely supported attr
                webkitdirectory=""
                directory=""
                onChange={handleFileInput}
              />
            </Button>
          </div>
          <div className="mt-3 space-y-1 text-xs text-muted-foreground">
            <p><span className="font-medium text-foreground/70">{t("importExport.upload.categoryScripture")}</span> — USFM, USX, SFM</p>
            <p><span className="font-medium text-foreground/70">{t("importExport.upload.categoryTranslation")}</span> — {t("importExport.upload.formatsTranslation")}</p>
            <p><span className="font-medium text-foreground/70">{t("importExport.upload.categoryDocuments")}</span> — {t("importExport.upload.formatsDocuments")}</p>
            <p><span className="font-medium text-foreground/70">{t("importExport.upload.categoryLocalization")}</span> — {t("importExport.upload.formatsLocalization")}</p>
            <p><span className="font-medium text-foreground/70">{t("importExport.upload.categorySubtitles")}</span> — {t("importExport.upload.formatsSubtitles")}</p>
            <p><span className="font-medium text-foreground/70">{t("importExport.upload.categoryParatextProject")}</span> — {t("importExport.upload.zipOrFolder")}</p>
            <p><span className="font-medium text-foreground/70">{t("importExport.upload.categoryOtherFormats")}</span> — {t("importExport.upload.otherFormatsHint")}</p>
          </div>
        </>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}
