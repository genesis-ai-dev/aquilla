import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  importFile,
  importEBible,
  importMacula,
  importTranslationNotes,
  importParatextProject,
  importParatextAsTarget,
  prepareEBibleTargetImport,
  applyEBibleTargetImport,
  type EBibleProgress,
  type EBibleTargetProgress,
  type EBibleMatchResult,
  type MaculaProgress,
  type TnProgress,
  type ParatextImportProgress,
  type SourceCellRef,
} from "@/lib/import"
import type { FileReference, ProjectTtsSettings } from "@/lib/parsers/types"
import { buildCastAdditions } from "@/lib/import/cast-from-speakers"
import { v7 as uuidv7 } from "uuid"
import { filesToProjectEntries } from "@/lib/import/file-entries"
import { detectParatextProject, type ProjectEntry } from "@/lib/parsers/paratext-project"
import type { SourceVerse } from "@/lib/parsers/paratext-pairing"
import {
  fetchTranslationsList,
  fetchTranslationText,
  parseEBibleCorpus,
  type EBibleTranslation,
} from "@/lib/parsers/ebible"
import { languagesEqual } from "@/lib/language-normalize"
import { EBibleTargetReviewPanel } from "@/components/EBibleTargetReviewPanel"
import { detectCollisions, type CollisionResult } from "@/lib/import-collision"

type Screen = "landing" | "upload" | "ebible" | "macula" | "tn" | "direction" | "result" | "collision"

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  /** Mints a sync-token scoped to (projectId, fileId) for the bulk upload. */
  getToken: (fileId: string) => Promise<string | null>
  onImported: (refs: FileReference[], inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string; explicit?: boolean }) => void | Promise<void>
  /** Optional: current project TTS settings. When provided alongside
   *  `onCastUpdated`, VTT/SRT imports with `<v Name>` tags will create cast
   *  members and cell assignments in a single batched write. */
  ttsSettings?: ProjectTtsSettings
  /** Callback to persist updated TTS settings (voices + castAssignments) after
   *  a subtitle import that contained speaker tags. */
  onCastUpdated?: (settings: Partial<ProjectTtsSettings>) => void | Promise<void>
  /**
   * Optional: existing source cells to support the "into target" eBible import
   * mode (FRO-191). When provided, the eBible panel shows a mode toggle so the
   * user can import a translation into the target column of an existing file.
   * Each cell needs at minimum: cellId, fileId, translated, canonicalRef, and
   * the AD-2 parentId fields (targetEventId / sourceEventId).
   */
  sourceCells?: SourceCellRef[]
  /**
   * FRO-287: files already in the project. Used by the collision guard to detect
   * re-imports and offer Skip / Import as duplicate choices. Wired from
   * ProjectWorkspace (FRO-272 glue); FileReference satisfies { name }.
   * Fresh projects (empty array or absent) skip the detection step.
   */
  existingFiles?: { name: string }[]
}

/** localStorage key used to persist the per-project "skip direction prompt" choice. */
function skipStorageKey(projectId: string) {
  return `codex.importDirectionSkipped.${projectId}`
}

export function ImportDialog({
  open,
  onOpenChange,
  projectId,
  username,
  sourceLanguage,
  targetLanguage,
  getToken,
  onImported,
  ttsSettings,
  onCastUpdated,
  sourceCells,
  existingFiles,
}: ImportDialogProps) {
  const [screen, setScreen] = useState<Screen>("landing")
  // Holds refs + inferred languages while waiting for the user to set direction.
  const [pendingImport, setPendingImport] = useState<{
    refs: FileReference[]
    inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }
  } | null>(null)
  // FRO-277: holds the partial-import result (skipped books) so the user can
  // read and copy the report before the dialog closes.
  const [importResult, setImportResult] = useState<{
    refs: FileReference[]
    inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }
    skipped: { book: string; reason: string }[]
  } | null>(null)
  const [directionSource, setDirectionSource] = useState("")
  const [directionTarget, setDirectionTarget] = useState("")
  // Guard against double-clicks on "Set direction".
  const [confirming, setConfirming] = useState(false)
  // FRO-249 fix: inline error shown when onImported throws from the direction screen.
  const [confirmError, setConfirmError] = useState<string | null>(null)
  // FRO-287: collision state — populated when a re-import is detected.
  const [collisionState, setCollisionState] = useState<{
    collisions: CollisionResult[]
    // Callback that continues the pending import once the user resolves collisions.
    proceed: (skipKeys: ReadonlySet<string>) => void | Promise<void>
  } | null>(null)
  // FRO-249 fix (Fix 3): guard against Radix delivering onOpenChange(false) twice
  // in the same macrotask (closure-captured pendingImport stays non-null until
  // the re-render). Consumed synchronously so the second call is a no-op.
  const flushingRef = useRef(false)

  // Reset to landing each time the dialog opens.
  useEffect(() => {
    if (open) {
      setScreen("landing")
      setPendingImport(null)
      setImportResult(null)
      setCollisionState(null)
      setConfirming(false)
      setConfirmError(null)
      flushingRef.current = false
    }
  }, [open])

  // BLOCKER 2: intercept dialog close — if we're on the direction screen with a
  // pending import, flush it via the skip path before propagating the close so
  // the imported files are never silently dropped.
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && pendingImport !== null) {
        // Fix 3: bail if we already started a flush this macrotask.
        if (flushingRef.current) {
          onOpenChange(nextOpen)
          return
        }
        flushingRef.current = true
        // Flush the pending import without language overrides (skip semantics).
        // SWARM-TODO(FRO-274): surface this as a user-visible banner ("Import
        // couldn't be saved — copy your files and try again") once the
        // ImportDialog report-flow agent lands (wave collisions risk). For now
        // the error stays console-only to avoid conflicting with that refactor.
        void Promise.resolve(onImported(pendingImport.refs, pendingImport.inferredLanguages)).catch((err: unknown) => {
          console.warn("[ImportDialog] flush-on-close failed:", err)
        })
        setPendingImport(null)
      }
      onOpenChange(nextOpen)
    },
    [pendingImport, onImported, onOpenChange],
  )

  // Called by child panels when they finish importing. If the language
  // direction is ambiguous (source==target or target is empty after source is
  // set), show the one-time direction prompt instead of closing immediately.
  // FRO-277: accepts an optional `skipped` array — if any books were skipped,
  // the result screen is shown FIRST so the user can read/copy the report before
  // the dialog auto-closes or they explicitly dismiss.
  const handleChildImported = useCallback(
    async (
      refs: FileReference[],
      inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string },
      skippedBooks?: { book: string; reason: string }[],
    ) => {
      // FRO-277: partial import — show result screen first, hold the close.
      if (skippedBooks && skippedBooks.length > 0) {
        setImportResult({ refs, inferredLanguages, skipped: skippedBooks })
        setScreen("result")
        // Persist per-project so a re-show is possible (bonus scope).
        try {
          const key = `codex.lastImportReport.${projectId}`
          localStorage.setItem(
            key,
            JSON.stringify({ ts: Date.now(), skipped: skippedBooks, importedCount: refs.length }),
          )
        } catch {
          // localStorage unavailable — ignore
        }
        return
      }

      const effectiveSource = (inferredLanguages?.sourceLanguage || sourceLanguage).trim()
      const effectiveTarget = (inferredLanguages?.targetLanguage || targetLanguage).trim()

      // Direction is ambiguous when: both empty, target is unset, or source==target
      // (using the normalizer so "French"=="fra" doesn't spuriously trigger this).
      // Small fix: also fire when both are empty (""=="" would otherwise pass the
      // effectiveSource!=="" gate and silently leave source==target=="").
      const bothEmpty = effectiveSource === "" && effectiveTarget === ""
      const needsDirection =
        bothEmpty ||
        (effectiveSource !== "" && (effectiveTarget === "" || languagesEqual(effectiveSource, effectiveTarget)))

      // Respect the persisted per-project skip choice so we don't re-prompt on
      // every import once the user has deliberately deferred direction setup.
      const skipped = localStorage.getItem(skipStorageKey(projectId)) === "true"

      if (needsDirection && !skipped) {
        setPendingImport({ refs, inferredLanguages })
        setDirectionSource(effectiveSource)
        setDirectionTarget(languagesEqual(effectiveSource, effectiveTarget) ? "" : effectiveTarget)
        setScreen("direction")
        return
      }

      await onImported(refs, inferredLanguages)
      onOpenChange(false)
    },
    [sourceLanguage, targetLanguage, projectId, onImported, onOpenChange],
  )

  // FRO-277: called from ResultPanel when the user explicitly dismisses the
  // import-result screen. At this point we flush the actual onImported callback
  // and close. If the result also triggers a direction prompt, we fall through
  // the normal direction-screen path.
  const handleResultDismiss = useCallback(async () => {
    if (!importResult) return
    const { refs, inferredLanguages } = importResult
    setImportResult(null)
    // Run through the normal post-import flow (direction prompt if needed).
    await handleChildImported(refs, inferredLanguages)
  }, [importResult, handleChildImported])

  // BLOCKER 1 fix: values confirmed via DirectionPanel are EXPLICIT — they
  // replace current values, not merely fill empty slots.
  async function handleDirectionConfirm() {
    if (!pendingImport || confirming) return
    // FRO-249 fix: clear inline error from any previous attempt.
    setConfirmError(null)
    setConfirming(true)
    const captured = pendingImport
    // Null out synchronously as a double-click guard.
    setPendingImport(null)
    try {
      const mergedLanguages = {
        ...(captured.inferredLanguages ?? {}),
        sourceLanguage: directionSource.trim() || captured.inferredLanguages?.sourceLanguage,
        targetLanguage: directionTarget.trim() || undefined,
        // BLOCKER 1: mark as explicit so handleImported in ProjectWorkspace
        // REPLACES current values instead of only filling empty slots.
        explicit: true,
      }
      await onImported(captured.refs, mergedLanguages)
      onOpenChange(false)
    } catch (err: unknown) {
      // FRO-249 fix: on failure restore the direction screen so the user can
      // retry or skip. The rejection MUST NOT escape as an unhandled rejection.
      setPendingImport(captured)
      const message = err instanceof Error ? err.message : String(err)
      setConfirmError(`Couldn't save your import — please try again. (${message})`)
    } finally {
      setConfirming(false)
    }
  }

  function handleDirectionSkip() {
    if (!pendingImport) return
    // Persist the skip so re-imports don't re-prompt this project.
    try {
      localStorage.setItem(skipStorageKey(projectId), "true")
    } catch {
      // localStorage may be unavailable in some environments — ignore silently.
    }
    const captured = pendingImport
    setPendingImport(null)
    // SWARM-TODO(FRO-274): surface this as a user-visible banner once the
    // ImportDialog report-flow agent lands — same wave-collision concern as above.
    void Promise.resolve(onImported(captured.refs, captured.inferredLanguages)).catch((err: unknown) => {
      console.warn("[ImportDialog] skip flush failed:", err)
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {screen === "landing" ? (
              "Import"
            ) : screen === "direction" ? (
              "Set translation direction"
            ) : screen === "result" ? (
              "Import complete — some books skipped"
            ) : screen === "collision" ? (
              "Re-import detected"
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setScreen("landing")}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Back to import types"
                >
                  ←
                </button>
                {screen === "upload" ? "Upload Files" : screen === "macula" ? "Macula Hebrew + Greek" : screen === "tn" ? "Translation Notes (TSV)" : "eBible Corpus"}
              </div>
            )}
          </DialogTitle>
        </DialogHeader>

        {screen === "landing" && (
          <ImportLanding onSelect={setScreen} />
        )}

        {screen === "upload" && (
          <UploadPanel
            projectId={projectId}
            username={username}
            sourceLanguage={sourceLanguage}
            targetLanguage={targetLanguage}
            getToken={getToken}
            ttsSettings={ttsSettings}
            onCastUpdated={onCastUpdated}
            existingFiles={existingFiles}
            onCollision={(collisions, proceed) => {
              setCollisionState({ collisions, proceed })
              setScreen("collision")
            }}
            onImported={handleChildImported}
          />
        )}

        {screen === "ebible" && (
          <EBiblePanel
            projectId={projectId}
            username={username}
            sourceLanguage={sourceLanguage}
            targetLanguage={targetLanguage}
            getToken={getToken}
            sourceCells={sourceCells}
            onImported={async (ref, inferredLanguages) => {
              await handleChildImported([ref], inferredLanguages)
            }}
            onTargetImported={() => {
              onOpenChange(false)
            }}
          />
        )}

        {screen === "macula" && (
          <MaculaPanel
            projectId={projectId}
            username={username}
            getToken={getToken}
            onImported={async (refs) => {
              // Macula imports carry per-file source_language overrides (hbo/grc).
              // Pass the first detected language as the project's inferred source
              // only when the project's current source language is unset.
              await handleChildImported(refs)
            }}
          />
        )}

        {screen === "tn" && (
          <TnPanel
            projectId={projectId}
            username={username}
            getToken={getToken}
            onImported={async (ref) => {
              await handleChildImported([ref])
            }}
          />
        )}

        {screen === "direction" && (
          <DirectionPanel
            sourceLanguage={directionSource}
            targetLanguage={directionTarget}
            onSourceChange={setDirectionSource}
            onTargetChange={setDirectionTarget}
            onConfirm={handleDirectionConfirm}
            onSkip={handleDirectionSkip}
            confirming={confirming}
            error={confirmError}
          />
        )}

        {/* FRO-277: partial-import result screen */}
        {screen === "result" && importResult && (
          <ImportResultPanel
            importedCount={importResult.refs.length}
            skipped={importResult.skipped}
            onDismiss={handleResultDismiss}
          />
        )}

        {/* FRO-287: collision guard — shown when re-importing into an existing project */}
        {screen === "collision" && collisionState && (
          <CollisionPanel
            collisions={collisionState.collisions}
            onResolve={async (skipKeys) => {
              setCollisionState(null)
              setScreen("upload")
              await collisionState.proceed(skipKeys)
            }}
            onCancel={() => {
              setCollisionState(null)
              setScreen("upload")
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Import landing — card grid
// ---------------------------------------------------------------------------

interface ImportLandingProps {
  onSelect: (screen: Screen) => void
}

function ImportLanding({ onSelect }: ImportLandingProps) {
  return (
    <div className="grid grid-cols-1 gap-3 py-2 sm:grid-cols-2">
      {/* Upload files — active */}
      <button
        type="button"
        onClick={() => onSelect("upload")}
        className="rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p className="text-sm font-medium">Upload Files</p>
        <p className="mt-1 text-xs text-muted-foreground">
          USFM, DOCX, TXT, VTT/SRT, XLIFF, TMX, CSV, audio/video — or a Paratext project folder/zip.
        </p>
      </button>

      {/* eBible Corpus — active */}
      <button
        type="button"
        onClick={() => onSelect("ebible")}
        className="rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p className="text-sm font-medium">
          eBible Corpus
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">(public Bible library)</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          A public library of openly-licensed Bible translations from around the world. Pick any redistributable version and import it directly — no file download needed.
        </p>
      </button>

      {/* Macula Hebrew + Greek — active (FRO-178) */}
      <button
        type="button"
        onClick={() => onSelect("macula")}
        className="rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p className="text-sm font-medium">Macula Hebrew + Greek</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Upload a Macula TSV file for the Hebrew Old Testament or Greek New Testament —
          original-language text with per-word lemma, morphology, and Strong's data.
        </p>
      </button>

      {/* Translation Memory (TMX) — coming soon (FRO-179) */}
      <div
        title="Coming soon — Translation Memory import is tracked in FRO-179"
        className="cursor-not-allowed rounded-lg border border-dashed p-4 text-left opacity-50"
      >
        <p className="text-sm font-medium">Translation Memory</p>
        <p className="mt-1 text-xs text-muted-foreground">
          TMX translation memory files. Coming soon.
        </p>
      </div>

      {/* Translation Notes — active (FRO-179) */}
      <button
        type="button"
        onClick={() => onSelect("tn")}
        className="rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p className="text-sm font-medium">Translation Notes (TSV)</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Upload unfoldingWord-style TN files. Notes appear in a sidebar when you focus a translation cell at the matching verse.
        </p>
      </button>
    </div>
  )
}

interface UploadPanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  getToken: (fileId: string) => Promise<string | null>
  /** FRO-277: third argument carries skipped books for partial Paratext imports. */
  onImported: (refs: FileReference[], inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }, skipped?: { book: string; reason: string }[]) => void | Promise<void>
  ttsSettings?: ProjectTtsSettings
  onCastUpdated?: (settings: Partial<ProjectTtsSettings>) => void | Promise<void>
  /**
   * FRO-287: files already in the project. Passed to detectCollisions before
   * any import starts; on collision, onCollision is called instead of proceeding.
   */
  existingFiles?: { name: string }[]
  /** FRO-287: called when collisions are detected; parent shows the collision screen. */
  onCollision?: (collisions: CollisionResult[], proceed: (skipKeys: ReadonlySet<string>) => void | Promise<void>) => void
}

function UploadPanel({ projectId, username, sourceLanguage, targetLanguage, getToken, onImported, ttsSettings, onCastUpdated, existingFiles, onCollision }: UploadPanelProps) {
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string>("")
  const [progress, setProgress] = useState<{ count: number; total: number } | null>(null)
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

      // FRO-287: single-file collision check before parsing/uploading.
      if (existingFiles && existingFiles.length > 0 && onCollision) {
        const incoming = list.map((f) => ({ name: f.name }))
        const collisions = detectCollisions(incoming, existingFiles)
        if (collisions.length > 0) {
          // Pause and ask the user; once resolved, re-run with a skipKeys set.
          onCollision(collisions, async (skipKeys) => {
            // Filter out skipped files and proceed with the rest.
            const filtered = list.filter((f) => !skipKeys.has(f.name.trim().toLowerCase()))
            if (filtered.length === 0) return
            await doImportFiles(filtered)
          })
          return
        }
      }

      await doImportFiles(list)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, username, sourceLanguage, targetLanguage, getToken, onImported, ttsSettings, onCastUpdated, existingFiles, onCollision]
  )

  /** Inner helper: import a resolved list of files (after collision resolution). */
  const doImportFiles = useCallback(
    async (list: File[]) => {
      setImporting(true)
      setProgress(null)
      const allRefs: FileReference[] = []
      // Accumulate speaker pairs across all subtitle files in this batch.
      const allSpeakerPairs: { cellId: string; speaker: string | undefined }[] = []
      try {
        for (const file of list) {
          setPhase(`Parsing ${file.name}…`)
          setProgress(null)
          // importFile returns speakerPairs from the SAME buildBulkCellsWithSpeakers
          // call that minted the uploaded cells — cellIds are guaranteed to match.
          const { refs, speakerPairs } = await importFile(file, {
            projectId,
            author: username,
            sourceLanguage,
            targetLanguage,
            getToken,
            onCellEnqueued: (count, total) => {
              setPhase(`Uploading ${file.name}`)
              setProgress({ count, total })
            },
          })
          allRefs.push(...refs)
          allSpeakerPairs.push(...speakerPairs)
        }
        // Apply cast additions if any subtitle speakers were found.
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
        setPhase("Finishing up…")
        await onImported(allRefs)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed")
      } finally {
        setImporting(false)
        setProgress(null)
        setPhase("")
      }
    },
    [projectId, username, sourceLanguage, targetLanguage, getToken, onImported, ttsSettings, onCastUpdated]
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
        getToken={getToken}
        onImported={onImported}
        onCancel={() => setParatextChoice(null)}
        existingFiles={existingFiles}
        onCollision={onCollision}
      />
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
          <p className="text-sm font-medium">{phase || "Importing…"}</p>
          {progress && progress.total > 0 ? (
            <>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((progress.count / progress.total) * 100)}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {progress.count.toLocaleString()} / {progress.total.toLocaleString()} cells
              </p>
            </>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">Working…</p>
          )}
        </div>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            Drag & drop files here, or
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer" />}>
              Choose Files
              <input
                type="file"
                multiple
                className="hidden"
                accept=".md,.markdown,.docx,.pptx,.txt,.vtt,.srt,.usfm,.sfm,.usx,.zip,.xlf,.xliff,.tmx,.csv,.tsv,.mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus,.mp4,.m4v,.mov,.webm,.mkv"
                onChange={handleFileInput}
              />
            </Button>
            <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer" />}>
              Choose Folder
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
            <p><span className="font-medium text-foreground/70">Scripture</span> — USFM, USX, SFM</p>
            <p><span className="font-medium text-foreground/70">Translation</span> — XLIFF/XLF, TMX, CSV/TSV</p>
            <p><span className="font-medium text-foreground/70">Documents</span> — DOCX, TXT, MD, PPTX</p>
            <p><span className="font-medium text-foreground/70">Subtitles</span> — VTT, SRT</p>
            <p><span className="font-medium text-foreground/70">Paratext project</span> — .zip or folder</p>
          </div>
        </>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

interface ParatextChoiceProps {
  entries: ProjectEntry[]
  bookCount: number
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  getToken: (fileId: string) => Promise<string | null>
  /** FRO-277: third argument carries skipped books from a partial import so the
   *  parent can show the result screen before closing. */
  onImported: (refs: FileReference[], inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }, skipped?: { book: string; reason: string }[]) => void | Promise<void>
  onCancel: () => void
  /** FRO-287: files already in the project; used for collision detection. */
  existingFiles?: { name: string }[]
  /** FRO-287: called when collisions are detected before running the import. */
  onCollision?: (collisions: CollisionResult[], proceed: (skipKeys: ReadonlySet<string>) => void | Promise<void>) => void
}

/** Source-vs-target choice for a detected Paratext project. Source imports the
 *  books as a reference text; target pairs the consultant's in-progress
 *  translation against an eBible source picked here (aligned by verse ref). */
function ParatextChoice({
  entries, bookCount, projectId, username, sourceLanguage, targetLanguage, getToken, onImported, onCancel,
  existingFiles, onCollision,
}: ParatextChoiceProps) {
  const [mode, setMode] = useState<"choose" | "pickSource" | "importing">("choose")
  const [phase, setPhase] = useState("")
  const [progress, setProgress] = useState<{ count: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [translations, setTranslations] = useState<EBibleTranslation[] | null>(null)
  const [query, setQuery] = useState("")

  const ctx = { projectId, author: username, sourceLanguage, targetLanguage, getToken }

  function onProgress(p: ParatextImportProgress) {
    setPhase(p.phase === "parse" ? `Importing ${p.book ?? "book"}…` : `Imported ${p.booksDone}/${p.booksTotal} books`)
    setProgress({ count: p.booksDone, total: p.booksTotal })
  }

  async function runSourceWithSkipKeys(skipKeys: ReadonlySet<string>) {
    setMode("importing"); setError(null); setPhase("Reading project…"); setProgress(null)
    try {
      const { refs, settings, skipped } = await importParatextProject(entries, { ...ctx, skipKeys }, onProgress)
      const inferredLang = settings.languageIsoCode || settings.language
      await onImported(refs, inferredLang ? { sourceLanguage: inferredLang } : undefined, skipped.length ? skipped : undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed"); setMode("choose")
    }
  }

  async function runSource() {
    // FRO-287: collision check before running the import.
    if (existingFiles && existingFiles.length > 0 && onCollision) {
      const detected = detectParatextProject(entries)
      if (detected) {
        // Derive collision candidates from the SFM entry filenames.
        // The bookId is the uppercase stem (e.g. "GEN" from "GEN.usfm").
        const incoming = detected.sfmEntries.map((e) => {
          const stem = e.name.replace(/\.(sfm|usfm)$/i, "").replace(/.*\//, "")
          const bookCode = stem.toUpperCase()
          return { name: stem, bookCode }
        })
        const collisions = detectCollisions(incoming, existingFiles)
        if (collisions.length > 0) {
          onCollision(collisions, (skipKeys) => runSourceWithSkipKeys(skipKeys))
          return
        }
      }
    }
    await runSourceWithSkipKeys(new Set())
  }

  async function startTarget() {
    setMode("pickSource"); setError(null)
    if (!translations) {
      try {
        setTranslations(await fetchTranslationsList())
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load the source list")
      }
    }
  }

  async function runTargetWithSkipKeys(sel: EBibleTranslation, skipKeys: ReadonlySet<string>) {
    setMode("importing"); setError(null); setPhase(`Fetching source: ${sel.title}…`); setProgress(null)
    try {
      const corpus = await fetchTranslationText(sel.id, () => {})
      const sourceVerses: SourceVerse[] = parseEBibleCorpus(corpus).map((s) => ({
        ref: s.globalReferences?.[0] ?? s.context,
        text: s.original,
      }))
      const selSourceLang = sel.languageCode || sel.id
      const { refs, settings, skipped } = await importParatextAsTarget(entries, sourceVerses, { ...ctx, sourceLanguage: selSourceLang, skipKeys }, onProgress)
      const inferredTargetLang = settings.languageIsoCode || settings.language
      await onImported(
        refs,
        { sourceLanguage: selSourceLang, targetLanguage: inferredTargetLang || undefined },
        skipped.length ? skipped : undefined,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed"); setMode("pickSource")
    }
  }

  async function runTarget(sel: EBibleTranslation) {
    // FRO-287: collision check before fetching source corpus.
    if (existingFiles && existingFiles.length > 0 && onCollision) {
      const detected = detectParatextProject(entries)
      if (detected) {
        const incoming = detected.sfmEntries.map((e) => {
          const stem = e.name.replace(/\.(sfm|usfm)$/i, "").replace(/.*\//, "")
          return { name: stem, bookCode: stem.toUpperCase() }
        })
        const collisions = detectCollisions(incoming, existingFiles)
        if (collisions.length > 0) {
          onCollision(collisions, (skipKeys) => runTargetWithSkipKeys(sel, skipKeys))
          return
        }
      }
    }
    await runTargetWithSkipKeys(sel, new Set())
  }

  const filtered = useMemo(() => {
    if (!translations) return []
    const q = query.trim().toLowerCase()
    const base = q
      ? translations.filter(
          (t) =>
            t.id.toLowerCase().includes(q) ||
            t.title.toLowerCase().includes(q) ||
            t.languageNameInEnglish.toLowerCase().includes(q),
        )
      : translations
    return base.slice(0, 200)
  }, [translations, query])

  if (mode === "importing") {
    return (
      <div className="mx-auto w-full max-w-sm py-8 text-center">
        <p className="text-sm font-medium">{phase || "Importing…"}</p>
        {progress && progress.total > 0 && (
          <>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((progress.count / progress.total) * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{progress.count} / {progress.total} books</p>
          </>
        )}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  if (mode === "pickSource") {
    return (
      <div className="flex flex-col gap-3 py-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Pick a source Bible to align against</p>
          <Button variant="ghost" size="sm" onClick={() => setMode("choose")}>Back</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          It just needs to be close — verses align by reference (e.g. MAT 1:1). Verses missing on either side stay blank.
        </p>
        <Input placeholder="Search translations (language, name, code)…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <ScrollArea className="h-64 rounded border">
          {!translations ? (
            <p className="p-3 text-sm text-muted-foreground">Loading source list…</p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No matches.</p>
          ) : (
            <ul className="divide-y">
              {filtered.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => runTarget(t)} className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-accent">
                    <span className="text-sm">{t.title}</span>
                    <span className="text-xs text-muted-foreground">{t.languageNameInEnglish} · {t.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <div>
        <p className="text-sm font-medium">Paratext project detected — {bookCount} book{bookCount === 1 ? "" : "s"}</p>
        <p className="text-xs text-muted-foreground">How should we bring it in?</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button type="button" onClick={runSource} className="rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5">
          <p className="text-sm font-medium">Source text</p>
          <p className="mt-1 text-xs text-muted-foreground">A reference Bible to translate from. Books import as source cells.</p>
        </button>
        <button type="button" onClick={startTarget} className="rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5">
          <p className="text-sm font-medium">Translation in progress</p>
          <p className="mt-1 text-xs text-muted-foreground">Your team's target text. We'll pair it with a source Bible by verse.</p>
        </button>
      </div>
      <div>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

interface EBiblePanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference, inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }) => void | Promise<void>
  /** When provided, enables the "into target" mode toggle (FRO-191). */
  sourceCells?: SourceCellRef[]
  /** Called after a successful target-column import (no new FileReference). */
  onTargetImported?: () => void
}

type EBiblePanelMode = "source" | "target"
type EBibleTargetStep = "pick" | "review" | "applying" | "done"

function EBiblePanel({ projectId, username, sourceLanguage, targetLanguage, getToken, sourceCells, onImported, onTargetImported }: EBiblePanelProps) {
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
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          t.languageNameInEnglish.toLowerCase().includes(q) ||
          t.languageName.toLowerCase().includes(q)
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
      // sourceLanguage so the project can seed it when unset (FRO-249).
      await onImported(ref, { sourceLanguage: selected.languageCode || selected.id })
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : "Import failed")
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
  // Target-import handlers (FRO-191)
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
      setTargetErr(err instanceof Error ? err.message : "Preparation failed")
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
        { projectId, author: username, getToken },
        setTargetProgress,
      )
      setTargetStep("done")
    } catch (err) {
      setTargetErr(err instanceof Error ? err.message : "Apply failed")
      setTargetStep("review")
    }
  }

  // ── Target: "applying" spinner ──────────────────────────────────────────────
  if (mode === "target" && targetStep === "applying") {
    return (
      <div className="mx-auto w-full max-w-sm py-8 text-center">
        <p className="text-sm font-medium">
          {targetProgress?.phase === "save" && targetProgress.cellsTotal
            ? `Committing ${(targetProgress.cellsEnqueued ?? 0).toLocaleString()} / ${targetProgress.cellsTotal.toLocaleString()} verses…`
            : "Committing verses…"}
        </p>
        {targetProgress?.phase === "save" && targetProgress.cellsTotal ? (
          <div className="mx-auto mt-3 h-2 w-full max-w-xs overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.round(((targetProgress.cellsEnqueued ?? 0) / targetProgress.cellsTotal) * 100)}%` }}
            />
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">Working…</p>
        )}
      </div>
    )
  }

  // ── Target: "done" confirmation ─────────────────────────────────────────────
  if (mode === "target" && targetStep === "done") {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <p className="text-sm font-medium">Target verses committed.</p>
        <p className="text-xs text-muted-foreground">
          The target column will update as the server projection lands.
        </p>
        <Button size="sm" onClick={() => onTargetImported?.()}>Close</Button>
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
        <div className="flex gap-1 rounded-md border p-1 text-xs">
          <button
            type="button"
            onClick={() => setMode("source")}
            className={cn(
              "flex-1 rounded px-2 py-1 transition-colors",
              mode === "source" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            New source file
          </button>
          <button
            type="button"
            onClick={() => setMode("target")}
            className={cn(
              "flex-1 rounded px-2 py-1 transition-colors",
              mode === "target" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Into target column
          </button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {mode === "source" ? (
          <>
            Import a Bible translation directly from the{" "}
            <a href="https://github.com/BibleNLP/ebible" target="_blank" rel="noreferrer" className="underline">
              BibleNLP/ebible corpus
            </a>
            . Only redistributable translations are included.
          </>
        ) : (
          <>
            Match eBible verses to existing source cells by canonical reference (e.g. GEN 1:1) and
            fill the target column. A review step lets you keep or replace any existing target content.
          </>
        )}
      </p>

      <Input
        placeholder="Search by language, title, or id (e.g. 'eng', 'KJV')"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={!translations || importing}
      />

      {loadErr ? (
        <p className="text-sm text-destructive">Failed to load list: {loadErr}</p>
      ) : !translations ? (
        <p className="text-sm text-muted-foreground">Loading translations...</p>
      ) : (
        <ScrollArea className="h-72 rounded-md border">
          <ul className="divide-y">
            {filtered.length === 0 && (
              <li className="p-3 text-sm text-muted-foreground">No matches.</li>
            )}
            {filtered.map((t) => {
              const isSelected = selected?.id === t.id
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={importing}
                    onClick={() => setSelected(t)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                      isSelected && "bg-accent"
                    )}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="font-medium">{t.title}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {t.id}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {t.languageNameInEnglish || t.languageName}
                      {t.otBooks + t.ntBooks > 0 && (
                        <> · {t.otBooks} OT · {t.ntBooks} NT</>
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
          <div className="text-muted-foreground">{selected.copyright || "No copyright info."}</div>
        </div>
      )}

      {/* Source mode: show source-upload progress */}
      {mode === "source" && progress && (
        <div className="text-xs text-muted-foreground">
          <p>
            {progress.phase === "download"
              ? `Downloading ${selected?.id ?? ""}… ${formatProgress(progress.received, progress.total)}`
              : progress.phase === "parse"
                ? "Parsing verses…"
                : progress.cellsTotal
                  ? `Uploading verses: ${(progress.cellsEnqueued ?? 0).toLocaleString()} / ${progress.cellsTotal.toLocaleString()}`
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

      {/* Target mode: show prepare-step progress */}
      {mode === "target" && targetProgress && (
        <div className="text-xs text-muted-foreground">
          <p>
            {targetProgress.phase === "download"
              ? `Downloading ${selected?.id ?? ""}… ${formatProgress(targetProgress.received, targetProgress.total)}`
              : targetProgress.phase === "parse"
                ? "Parsing verses…"
                : "Matching verses to source cells…"}
          </p>
        </div>
      )}

      {importErr && <p className="text-sm text-destructive">{importErr}</p>}
      {targetErr && <p className="text-sm text-destructive">{targetErr}</p>}

      <div className="flex justify-end">
        {mode === "source" ? (
          <Button onClick={handleImport} disabled={!selected || importing}>
            {importing ? "Importing..." : "Import"}
          </Button>
        ) : (
          <Button onClick={handlePrepareTarget} disabled={!selected || importing || !sourceCells?.length}>
            {importing ? "Preparing…" : "Next: Review matches"}
          </Button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Direction prompt — shown once when source/target are ambiguous (FRO-249)
// ---------------------------------------------------------------------------

interface DirectionPanelProps {
  sourceLanguage: string
  targetLanguage: string
  onSourceChange: (v: string) => void
  onTargetChange: (v: string) => void
  onConfirm: () => void
  onSkip: () => void
  confirming?: boolean
  /** FRO-249: shown inline when onImported throws so the user can retry. */
  error?: string | null
}

/** One-time prompt shown after import when source==target or target is unset.
 *  The user enters source and target language so back-translation and QA rules
 *  operate against the correct language pair.
 *
 *  WARN c: both fields are editable — explicit user input always wins over the
 *  project's existing values (consistent with BLOCKER 1 explicit-wins fix). */
function DirectionPanel({
  sourceLanguage,
  targetLanguage,
  onSourceChange,
  onTargetChange,
  onConfirm,
  onSkip,
  confirming = false,
  error = null,
}: DirectionPanelProps) {
  // WARN e: use normalizer so "French"=="fra" registers as same and blocks confirm.
  const targetTrimmed = targetLanguage.trim()
  const sourceTrimmed = sourceLanguage.trim()
  const confirmDisabled =
    confirming ||
    !targetTrimmed ||
    languagesEqual(targetTrimmed, sourceTrimmed)

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        We detected the source language from the imported project. Please confirm the
        source and set the target language so back-translation and QA rules work correctly.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="dl-source">
            Source language
          </label>
          <Input
            id="dl-source"
            value={sourceLanguage}
            onChange={(e) => onSourceChange(e.target.value)}
            placeholder="e.g. English, arb, hbo"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="dl-target">
            Target language <span className="text-destructive">*</span>
          </label>
          <Input
            id="dl-target"
            value={targetLanguage}
            onChange={(e) => onTargetChange(e.target.value)}
            placeholder="e.g. Spanish, fra, swh"
            autoFocus
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        You can change these later in <strong>Project Settings → Project Info</strong>.
      </p>
      {/* FRO-249: restore direction screen on failure so the user can retry */}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onSkip} disabled={confirming}>
          Skip for now
        </Button>
        <Button
          size="sm"
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          {confirming ? "Setting…" : "Set direction"}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Import result panel — FRO-277
// Shows the full skip report after a partial Paratext import. The user must
// explicitly dismiss (or copy and then dismiss) before the dialog closes.
// ---------------------------------------------------------------------------

interface ImportResultPanelProps {
  importedCount: number
  skipped: { book: string; reason: string }[]
  onDismiss: () => void | Promise<void>
}

function ImportResultPanel({ importedCount, skipped, onDismiss }: ImportResultPanelProps) {
  const [copied, setCopied] = useState(false)
  const [dismissing, setDismissing] = useState(false)

  const reportText = [
    `Import complete: ${importedCount} book${importedCount === 1 ? "" : "s"} imported, ${skipped.length} skipped.`,
    "",
    "Skipped books:",
    ...skipped.map((s) => `  ${s.book}: ${s.reason}`),
  ].join("\n")

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(reportText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard not available — ignore
    }
  }

  async function handleDismiss() {
    if (dismissing) return
    setDismissing(true)
    try {
      await onDismiss()
    } finally {
      setDismissing(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{importedCount}</span> book{importedCount === 1 ? "" : "s"} imported
        successfully; <span className="font-medium text-amber-600">{skipped.length}</span> could not be imported.
        Review the list below and copy it before closing.
      </p>
      <ScrollArea className="h-56 rounded-md border bg-muted/30 p-3">
        <ul className="space-y-1">
          {skipped.map((s, i) => (
            <li key={i} className="text-xs">
              <span className="font-medium">{s.book}</span>
              <span className="text-muted-foreground"> — {s.reason}</span>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <div className="flex justify-between gap-2">
        <Button variant="outline" size="sm" onClick={handleCopy} disabled={dismissing}>
          {copied ? "Copied!" : "Copy report"}
        </Button>
        <Button size="sm" onClick={handleDismiss} disabled={dismissing}>
          {dismissing ? "Closing…" : "Close"}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collision guard panel — FRO-287
// Shown when re-importing into a project that already has matching files.
// Offers Skip / Import as duplicate per collision. Apply-to-all toggle lets
// the user resolve the whole batch in one click.
//
// Replace-existing is NOT included in this pass because superseding the
// content of existing cells would require a cross-file cell-update write path
// that doesn't exist yet (the import pipeline only creates new cells). The UI
// doesn't show a "Replace" button rather than showing a disabled one so users
// aren't confused by a grayed-out option.
// ---------------------------------------------------------------------------

type CollisionChoice = "skip" | "duplicate"

interface CollisionPanelProps {
  collisions: CollisionResult[]
  onResolve: (skipKeys: ReadonlySet<string>) => void | Promise<void>
  onCancel: () => void
}

/** Per-collision prompt with apply-to-all toggle. */
function CollisionPanel({ collisions, onResolve, onCancel }: CollisionPanelProps) {
  // Map from incoming name → choice. Default is "skip" (safe default).
  const [choices, setChoices] = useState<Map<string, CollisionChoice>>(() => {
    const m = new Map<string, CollisionChoice>()
    for (const c of collisions) m.set(c.name, "skip")
    return m
  })
  const [resolving, setResolving] = useState(false)

  function setAll(choice: CollisionChoice) {
    setChoices((prev) => {
      const next = new Map(prev)
      for (const key of next.keys()) next.set(key, choice)
      return next
    })
  }

  function toggle(name: string) {
    setChoices((prev) => {
      const next = new Map(prev)
      next.set(name, prev.get(name) === "skip" ? "duplicate" : "skip")
      return next
    })
  }

  async function handleConfirm() {
    if (resolving) return
    setResolving(true)
    try {
      // Build skipKeys: normalized keys for every item the user chose to skip.
      const skipKeys = new Set<string>()
      for (const [name, choice] of choices) {
        if (choice === "skip") {
          // Key must match what importFile / importParatextProject checks.
          // bookCode (uppercase) or normalized name (lowercase trimmed).
          const collision = collisions.find((c) => c.name === name)
          if (collision?.bookCode) {
            skipKeys.add(collision.bookCode.toUpperCase())
          } else {
            skipKeys.add(name.trim().toLowerCase())
          }
        }
      }
      await onResolve(skipKeys)
    } finally {
      setResolving(false)
    }
  }

  const allSkip = [...choices.values()].every((v) => v === "skip")
  const allDup = [...choices.values()].every((v) => v === "duplicate")

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        The following {collisions.length === 1 ? "file already exists" : `${collisions.length} files already exist`} in this
        project. Choose what to do with each one.
      </p>

      {/* Apply-to-all row */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Apply to all:</span>
        <button
          type="button"
          onClick={() => setAll("skip")}
          className={cn(
            "rounded border px-2 py-0.5 transition-colors",
            allSkip ? "border-primary bg-primary/10 text-primary" : "border-muted text-muted-foreground hover:border-foreground/40",
          )}
        >
          Skip all
        </button>
        <button
          type="button"
          onClick={() => setAll("duplicate")}
          className={cn(
            "rounded border px-2 py-0.5 transition-colors",
            allDup ? "border-primary bg-primary/10 text-primary" : "border-muted text-muted-foreground hover:border-foreground/40",
          )}
        >
          Import all as duplicates
        </button>
      </div>

      {/* Per-collision rows */}
      <ScrollArea className="max-h-64 rounded-md border">
        <ul className="divide-y">
          {collisions.map((c) => {
            const choice = choices.get(c.name) ?? "skip"
            return (
              <li key={c.name} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    Existing: {c.existingName}
                    {c.bookCode ? ` (${c.bookCode})` : ""}
                  </p>
                </div>
                {/* Toggle between Skip and Duplicate */}
                <div className="flex shrink-0 gap-1 text-xs">
                  <button
                    type="button"
                    onClick={() => choice !== "skip" && toggle(c.name)}
                    className={cn(
                      "rounded border px-2 py-0.5 transition-colors",
                      choice === "skip"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted text-muted-foreground hover:border-foreground/40",
                    )}
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    onClick={() => choice !== "duplicate" && toggle(c.name)}
                    className={cn(
                      "rounded border px-2 py-0.5 transition-colors",
                      choice === "duplicate"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted text-muted-foreground hover:border-foreground/40",
                    )}
                  >
                    Import as duplicate
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </ScrollArea>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={resolving}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleConfirm} disabled={resolving}>
          {resolving ? "Continuing…" : "Continue"}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Macula Hebrew + Greek panel (FRO-178)
// ---------------------------------------------------------------------------

interface MaculaPanelProps {
  projectId: string
  username: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (refs: FileReference[]) => void | Promise<void>
}

function MaculaPanel({ projectId, username, getToken, onImported }: MaculaPanelProps) {
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<MaculaProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)

  async function handleImport() {
    if (!file || importing) return
    setImporting(true)
    setError(null)
    setProgress({ phase: "parse" })
    try {
      const refs = await importMacula(file, { projectId, author: username, getToken }, setProgress)
      await onImported(refs)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-xs text-muted-foreground">
        Upload a Macula TSV file obtained from{" "}
        <a
          href="https://github.com/Clear-Bible/macula-hebrew"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Clear Bible's Macula project
        </a>
        . Each TSV file represents one biblical book. The Hebrew and Greek word-level
        morphology (lemma, morph code, Strong's) will be preserved alongside the verse text.
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer" />}>
          {file ? file.name : "Choose Macula TSV file"}
          <input
            type="file"
            className="hidden"
            accept=".tsv,.txt,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              setFile(f)
              setError(null)
            }}
            disabled={importing}
          />
        </Button>
        {file && !importing && (
          <p className="text-xs text-muted-foreground">{file.name} — {(file.size / 1024).toFixed(0)} KB</p>
        )}
      </div>
      {progress && (
        <div className="text-xs text-muted-foreground">
          {progress.phase === "parse" && "Parsing verse data…"}
          {progress.phase === "save" && progress.cellsTotal && (
            <>
              <p>Uploading: {(progress.cellsEnqueued ?? 0).toLocaleString()} / {progress.cellsTotal.toLocaleString()} cells</p>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round(((progress.cellsEnqueued ?? 0) / progress.cellsTotal) * 100)}%` }}
                />
              </div>
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={!file || importing}>
          {importing ? "Importing…" : "Import"}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Translation Notes (TSV) panel (FRO-179)
// ---------------------------------------------------------------------------

interface TnPanelProps {
  projectId: string
  username: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference) => void | Promise<void>
}

function TnPanel({ projectId, username, getToken, onImported }: TnPanelProps) {
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<TnProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)

  async function handleImport() {
    if (!file || importing) return
    setImporting(true)
    setError(null)
    setProgress({ phase: "parse" })
    try {
      const ref = await importTranslationNotes(
        file,
        { projectId, author: username, getToken },
        setProgress,
      )
      await onImported(ref)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-xs text-muted-foreground">
        Upload an{" "}
        <a
          href="https://door43.org/u/Door43-Catalog/en_tn/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          unfoldingWord-style Translation Notes
        </a>{" "}
        TSV file. Each row becomes a note cell; notes appear in a sidebar when you focus a
        translation cell at the matching verse reference.
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer" />}>
          {file ? file.name : "Choose Translation Notes TSV"}
          <input
            type="file"
            className="hidden"
            accept=".tsv,.txt,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              setFile(f)
              setError(null)
            }}
            disabled={importing}
          />
        </Button>
        {file && !importing && (
          <p className="text-xs text-muted-foreground">{file.name} — {(file.size / 1024).toFixed(0)} KB</p>
        )}
      </div>
      {progress && (
        <div className="text-xs text-muted-foreground">
          {progress.phase === "parse" && "Parsing translation notes…"}
          {progress.phase === "save" && progress.cellsTotal && (
            <>
              <p>Uploading: {(progress.cellsEnqueued ?? 0).toLocaleString()} / {progress.cellsTotal.toLocaleString()} notes</p>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round(((progress.cellsEnqueued ?? 0) / progress.cellsTotal) * 100)}%` }}
                />
              </div>
              {progress.skippedCount ? (
                <p className="mt-1 text-yellow-600">{progress.skippedCount} rows skipped (missing canonical reference)</p>
              ) : null}
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={!file || importing}>
          {importing ? "Importing…" : "Import"}
        </Button>
      </div>
    </div>
  )
}

function formatProgress(received: number | undefined, total: number | undefined): string {
  if (!received) return "0 MB"
  const mb = (received / (1024 * 1024)).toFixed(1)
  if (!total) return `${mb} MB`
  const totalMb = (total / (1024 * 1024)).toFixed(1)
  const pct = Math.round((received / total) * 100)
  return `${mb} / ${totalMb} MB (${pct}%)`
}
