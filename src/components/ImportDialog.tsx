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
  type EBibleProgress,
  type MaculaProgress,
  type TnProgress,
  type ParatextImportProgress,
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

type Screen = "landing" | "upload" | "ebible" | "macula" | "tn" | "direction"

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
}: ImportDialogProps) {
  const [screen, setScreen] = useState<Screen>("landing")
  // Holds refs + inferred languages while waiting for the user to set direction.
  const [pendingImport, setPendingImport] = useState<{
    refs: FileReference[]
    inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }
  } | null>(null)
  const [directionSource, setDirectionSource] = useState("")
  const [directionTarget, setDirectionTarget] = useState("")
  // Guard against double-clicks on "Set direction".
  const [confirming, setConfirming] = useState(false)
  // FRO-249 fix: inline error shown when onImported throws from the direction screen.
  const [confirmError, setConfirmError] = useState<string | null>(null)
  // FRO-249 fix (Fix 3): guard against Radix delivering onOpenChange(false) twice
  // in the same macrotask (closure-captured pendingImport stays non-null until
  // the re-render). Consumed synchronously so the second call is a no-op.
  const flushingRef = useRef(false)

  // Reset to landing each time the dialog opens.
  useEffect(() => {
    if (open) {
      setScreen("landing")
      setPendingImport(null)
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
  const handleChildImported = useCallback(
    async (refs: FileReference[], inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }) => {
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
            onImported={async (ref, inferredLanguages) => {
              await handleChildImported([ref], inferredLanguages)
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
  onImported: (refs: FileReference[], inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }) => void | Promise<void>
  ttsSettings?: ProjectTtsSettings
  onCastUpdated?: (settings: Partial<ProjectTtsSettings>) => void | Promise<void>
}

function UploadPanel({ projectId, username, sourceLanguage, targetLanguage, getToken, onImported, ttsSettings, onCastUpdated }: UploadPanelProps) {
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
  onImported: (refs: FileReference[], inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }) => void | Promise<void>
  onCancel: () => void
}

/** Source-vs-target choice for a detected Paratext project. Source imports the
 *  books as a reference text; target pairs the consultant's in-progress
 *  translation against an eBible source picked here (aligned by verse ref). */
function ParatextChoice({
  entries, bookCount, projectId, username, sourceLanguage, targetLanguage, getToken, onImported, onCancel,
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

  async function runSource() {
    setMode("importing"); setError(null); setPhase("Reading project…"); setProgress(null)
    try {
      const { refs, settings, skipped } = await importParatextProject(entries, ctx, onProgress)
      if (skipped.length) {
        setError(`Imported ${refs.length}; skipped ${skipped.length}: ${skipped.slice(0, 3).map((s) => s.book).join(", ")}`)
      }
      // Propagate language inferred from Paratext Settings.xml so the project
      // can seed its sourceLanguage when it was unset (FRO-249).
      const inferredLang = settings.languageIsoCode || settings.language
      await onImported(refs, inferredLang ? { sourceLanguage: inferredLang } : undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed"); setMode("choose")
    }
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

  async function runTarget(sel: EBibleTranslation) {
    setMode("importing"); setError(null); setPhase(`Fetching source: ${sel.title}…`); setProgress(null)
    try {
      const corpus = await fetchTranslationText(sel.id, () => {})
      const sourceVerses: SourceVerse[] = parseEBibleCorpus(corpus).map((s) => ({
        ref: s.globalReferences?.[0] ?? s.context,
        text: s.original,
      }))
      // WARN d fix: use languageCode (e.g. "eng") not sel.id ("eng-engKJV") as the source language.
      const selSourceLang = sel.languageCode || sel.id
      const { refs, settings, skipped } = await importParatextAsTarget(entries, sourceVerses, { ...ctx, sourceLanguage: selSourceLang }, onProgress)
      if (skipped.length) setError(`Imported ${refs.length}; skipped ${skipped.length}`)
      // The Paratext project IS the target; selSourceLang is the eBible source language.
      // Propagate both so the project's source/target direction is set (FRO-249).
      const inferredTargetLang = settings.languageIsoCode || settings.language
      await onImported(
        refs,
        { sourceLanguage: selSourceLang, targetLanguage: inferredTargetLang || undefined },
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed"); setMode("pickSource")
    }
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
}

function EBiblePanel({ projectId, username, sourceLanguage, targetLanguage, getToken, onImported }: EBiblePanelProps) {
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

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Import a Bible translation directly from the{" "}
        <a
          href="https://github.com/BibleNLP/ebible"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          BibleNLP/ebible corpus
        </a>
        . Only redistributable translations are included.
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

      {progress && (
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
      {importErr && <p className="text-sm text-destructive">{importErr}</p>}

      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={!selected || importing}>
          {importing ? "Importing..." : "Import"}
        </Button>
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
