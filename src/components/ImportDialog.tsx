import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Upload, Library, Globe, Table2, Languages, ArrowLeft, ArrowLeftRight, Tags, StickyNote, Database,
  BookImage, BookA, Search, Cloud,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  importFile,
  importEBible,
  importObs,
  importHelloao,
  importMacula,
  importTranslationNotes,
  prepareParatextProject,
  commitParatextProject,
  importParatextAsTarget,
  type ParatextPlan,
  prepareEBibleTargetImport,
  applyEBibleTargetImport,
  prepareImportFile,
  type EBibleProgress,
  type EBibleTargetProgress,
  type EBibleMatchResult,
  type MaculaProgress,
  type TnProgress,
  type ParatextImportProgress,
  type SourceCellRef,
  type ImportResult,
} from "@/lib/import"
import type { PreparedImportFile } from "@/lib/import/import-service"
import { importSdbh, type SdbhImportProgress } from "@/lib/import-sdbh"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
import { PreviewPanel, type ImportUploadProgress } from "@/components/import/PreviewPanel"
import { formatBytesProgress } from "@/lib/format-bytes"
import type { FileReference, ProjectTtsSettings } from "@/lib/parsers/types"
import { detectFileType, isMediaFileType } from "@/lib/parsers/types"
import { buildCastAdditions } from "@/lib/import/cast-from-speakers"
import { v7 as uuidv7 } from "uuid"
import { filesToProjectEntries } from "@/lib/import/file-entries"
import { detectParatextProject, type ProjectEntry } from "@/lib/parsers/paratext-project"
import { usfmDisplayText } from "@/lib/parsers/usfm-display"
import type { SourceVerse } from "@/lib/parsers/paratext-pairing"
import {
  fetchTranslationsList,
  fetchTranslationText,
  parseEBibleCorpus,
  type EBibleTranslation,
} from "@/lib/parsers/ebible"
import {
  fetchHelloaoTranslations,
  fetchHelloaoBooks,
  type HelloaoTranslation,
  type HelloaoBook,
} from "@/lib/parsers/helloao"
import { getTestament } from "@/lib/codex-editor/bible-books"
import { languagesEqual } from "@/lib/language-normalize"
import { EBibleTargetReviewPanel } from "@/components/EBibleTargetReviewPanel"
import { detectCollisions, type CollisionResult } from "@/lib/import-collision"

interface CollisionResolution {
  skipKeys: ReadonlySet<string>
  /** normalized incoming book-code/name → existing file id */
  reimportFileIds: ReadonlyMap<string, string>
}
import posthog from "@/lib/posthog"
import {
  IMPORT_STARTED,
  IMPORT_SUCCEEDED,
  IMPORT_PARTIAL,
  IMPORT_FAILED,
  IMPORT_COLLISION_DETECTED,
  IMPORT_COLLISION_SKIPPED,
  IMPORT_COLLISION_DUPLICATED,
} from "@/lib/event-names"
import { SpreadsheetImportPanel } from "@/components/import/SpreadsheetImportPanel"
import { LabelImportPanel, type LabelImportResult } from "@/components/import/LabelImportPanel"
import { PairedImportPanel } from "@/components/import/PairedImportPanel"
import { DcsCatalogBrowser } from "@/components/dcs/DcsCatalogBrowser"
import { importDcsResource } from "@/lib/dcs/import-dcs"
import { DcsClient } from "@/lib/dcs/catalog"
import type { DcsCatalogEntry, DcsCursor } from "@/lib/dcs/types"

type Screen = "landing" | "upload" | "preview" | "ebible" | "helloao" | "obs" | "macula" | "tn" | "direction" | "result" | "collision" | "spreadsheet" | "labels" | "paired" | "sdbh" | "dcs"

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  /** Active target-lane storage key. Empty means the project default lane. */
  targetLang?: string
  /** Identity JWT used only when a format needs AI-assisted analysis. */
  identityToken?: string
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
   * mode (AQU-191). When provided, the eBible panel shows a mode toggle so the
   * user can import a translation into the target column of an existing file.
   * Each cell needs at minimum: cellId, fileId, translated, canonicalRef, and
   * the AD-2 parentId fields (targetEventId / sourceEventId).
   */
  sourceCells?: SourceCellRef[]
  /**
   * AQU-287: files already in the project. Used by the collision guard to detect
   * re-imports and offer Update existing / Skip / Import as duplicate. Wired from
   * ProjectWorkspace (AQU-272 glue); FileReference satisfies { name }.
   * Fresh projects (empty array or absent) skip the detection step.
   */
  existingFiles?: { id?: string; name: string; bookCode?: string }[]
  /**
   * DCS (Door43) import (spec §8/§9): persist the `dcsUpstream` cursor to the
   * current project's settings after a successful import, pinning it to the
   * chosen release. Wired from ProjectWorkspace to `useProject().patchSettings`.
   * When absent, the Door43 source option is hidden (the import can't pin
   * without a way to write settings). Returns true on a successful save.
   */
  patchDcsCursor?: (cursor: DcsCursor) => Promise<boolean>
  /**
   * AQU-314: project files for the Cell-labels panel's step-1 file picker.
   * The panel fetches the selected file's source cells itself, so labels no
   * longer depend on which file happens to be active in the editor.
   */
  projectFiles?: { id: string; name: string }[]
  /** AQU-314: the workspace's active file — pre-selected in the picker. */
  activeFileId?: string | null
  /**
   * AQU-314: called after a label apply run completes and the dialog closes.
   * The host surfaces the result (applied/unmatched counts) as its transient
   * status notice — the dialog itself is gone by then.
   */
  onLabelsImported?: (result: LabelImportResult) => void
  /**
   * AQU-634: per-project USFM front-matter opt-out. When true, USFM imports
   * (upload, Paratext project, DCS/Door43) exclude book-name/title/TOC +
   * intro-block cells. Wired from the project's `importExcludeFrontMatter`
   * setting. Absent/false imports front matter (the default).
   */
  excludeFrontMatter?: boolean
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
  targetLang,
  identityToken,
  getToken,
  onImported,
  ttsSettings,
  onCastUpdated,
  sourceCells,
  existingFiles,
  patchDcsCursor,
  projectFiles,
  activeFileId,
  onLabelsImported,
  excludeFrontMatter,
}: ImportDialogProps) {
  const [screen, setScreen] = useState<Screen>("landing")
  // Holds refs + inferred languages while waiting for the user to set direction.
  const [pendingImport, setPendingImport] = useState<{
    refs: FileReference[]
    inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }
  } | null>(null)
  // AQU-277: holds the partial-import result (skipped books) so the user can
  // read and copy the report before the dialog closes.
  const [importResult, setImportResult] = useState<{
    refs: FileReference[]
    inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }
    skipped: { book: string; reason: string }[]
  } | null>(null)
  const [importResultError, setImportResultError] = useState<string | null>(null)
  const [directionSource, setDirectionSource] = useState("")
  const [directionTarget, setDirectionTarget] = useState("")
  // Guard against double-clicks on "Set direction".
  const [confirming, setConfirming] = useState(false)
  // AQU-249 fix: inline error shown when onImported throws from the direction screen.
  const [confirmError, setConfirmError] = useState<string | null>(null)
  // AQU-287: collision state — populated when a re-import is detected.
  const [collisionState, setCollisionState] = useState<{
    collisions: CollisionResult[]
    // Callback that continues the pending import once the user resolves collisions.
    proceed: (resolution: CollisionResolution) => void | Promise<void>
  } | null>(null)
  // AQU-310: preview state — parsed results waiting for user confirmation before upload.
  const [previewState, setPreviewState] = useState<{
    results: ImportResult[]
    /** Commits the parsed results to the server once user confirms. */
    commit: () => void | Promise<void>
    /** Surface to restore if the user cancels the preview. */
    returnScreen: "upload" | "spreadsheet"
  } | null>(null)
  const [spreadsheetSeedFile, setSpreadsheetSeedFile] = useState<File | null>(null)
  const [spreadsheetReturnScreen, setSpreadsheetReturnScreen] = useState<"landing" | "upload">("landing")
  // AQU-430: upload progress surfaced from UploadPanel's doCommit while the
  // preview screen is active (UploadPanel is unmounted; these live here so
  // PreviewPanel can render an in-flight indicator).
  const [previewUploadPhase, setPreviewUploadPhase] = useState("")
  const [previewUploadProgress, setPreviewUploadProgress] = useState<ImportUploadProgress | null>(null)
  // AQU-430 (fix): a commit failure must be visible during the preview screen.
  // UploadPanel is unmounted here, so its local error never shows — surface it
  // up to this level and pass it to PreviewPanel instead of failing silently.
  const [previewCommitError, setPreviewCommitError] = useState<string | null>(null)
  // AQU-249 fix (Fix 3): guard against Radix delivering onOpenChange(false) twice
  // in the same macrotask (closure-captured pendingImport stays non-null until
  // the re-render). Consumed synchronously so the second call is a no-op.
  const flushingRef = useRef(false)

  // Reset to landing each time the dialog opens.
  useEffect(() => {
    if (open) {
      setScreen("landing")
      setPendingImport(null)
      setImportResult(null)
      setImportResultError(null)
      setCollisionState(null)
      setPreviewState(null)
      setPreviewUploadPhase("")
      setPreviewUploadProgress(null)
      setSpreadsheetSeedFile(null)
      setSpreadsheetReturnScreen("landing")
      setConfirming(false)
      setConfirmError(null)
      flushingRef.current = false
    }
  }, [open])

  const finishPendingImport = useCallback(async (
    captured: NonNullable<typeof pendingImport>,
    rememberSkip: boolean,
  ) => {
    if (flushingRef.current) return
    flushingRef.current = true
    setConfirming(true)
    setConfirmError(null)
    try {
      await onImported(captured.refs, captured.inferredLanguages)
      if (rememberSkip) {
        try {
          localStorage.setItem(skipStorageKey(projectId), "true")
        } catch {
          // localStorage may be unavailable; the import itself still succeeded.
        }
      }
      setPendingImport(null)
      onOpenChange(false)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setPendingImport(captured)
      setConfirmError(`Couldn't finish saving your import — please try again. (${message})`)
    } finally {
      flushingRef.current = false
      setConfirming(false)
    }
  }, [onImported, onOpenChange, projectId])

  // Intercept dialog close while an imported file still needs its final project
  // handoff. Keep the dialog visible until that async write succeeds; on failure
  // the same direction screen shows a retryable error instead of closing and
  // leaving a console-only warning.
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && pendingImport !== null) {
        void finishPendingImport(pendingImport, false)
        return
      }
      onOpenChange(nextOpen)
    },
    [finishPendingImport, pendingImport, onOpenChange],
  )

  // Called by child panels when they finish importing. If the language
  // direction is ambiguous (source==target or target is empty after source is
  // set), show the one-time direction prompt instead of closing immediately.
  // AQU-277: accepts an optional `skipped` array — if any books were skipped,
  // the result screen is shown FIRST so the user can read/copy the report before
  // the dialog auto-closes or they explicitly dismiss.
  const handleChildImported = useCallback(
    async (
      refs: FileReference[],
      inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string },
      skippedBooks?: { book: string; reason: string }[],
    ) => {
      // AQU-277: partial import — show result screen first, hold the close.
      if (skippedBooks && skippedBooks.length > 0) {
        posthog.capture(IMPORT_PARTIAL, {
          imported_count: refs.length,
          skipped_count: skippedBooks.length,
          project_id: projectId,
        })
        setImportResult({ refs, inferredLanguages, skipped: skippedBooks })
        setImportResultError(null)
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

      posthog.capture(IMPORT_SUCCEEDED, {
        file_count: refs.length,
        project_id: projectId,
      })
      await onImported(refs, inferredLanguages)
      onOpenChange(false)
    },
    [sourceLanguage, targetLanguage, projectId, onImported, onOpenChange],
  )

  // AQU-277: called from ResultPanel when the user explicitly dismisses the
  // import-result screen. At this point we flush the actual onImported callback
  // and close. If the result also triggers a direction prompt, we fall through
  // the normal direction-screen path.
  const handleResultDismiss = useCallback(async () => {
    if (!importResult) return
    const { refs, inferredLanguages } = importResult
    setImportResultError(null)
    try {
      // Run through the normal post-import flow (direction prompt if needed).
      // Retain the report until the handoff succeeds so Close is safely retryable.
      await handleChildImported(refs, inferredLanguages)
      setImportResult(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setImportResultError(`Couldn't finish saving your import — please try again. (${message})`)
    }
  }, [importResult, handleChildImported])

  // BLOCKER 1 fix: values confirmed via DirectionPanel are EXPLICIT — they
  // replace current values, not merely fill empty slots.
  async function handleDirectionConfirm() {
    if (!pendingImport || confirming || flushingRef.current) return
    // AQU-249 fix: clear inline error from any previous attempt.
    setConfirmError(null)
    setConfirming(true)
    flushingRef.current = true
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
      // AQU-249 fix: on failure restore the direction screen so the user can
      // retry or skip. The rejection MUST NOT escape as an unhandled rejection.
      setPendingImport(captured)
      const message = err instanceof Error ? err.message : String(err)
      setConfirmError(`Couldn't save your import — please try again. (${message})`)
    } finally {
      flushingRef.current = false
      setConfirming(false)
    }
  }

  function handleDirectionSkip() {
    if (!pendingImport || confirming) return
    void finishPendingImport(pendingImport, true)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[90dvh] sm:max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>
            {screen === "landing" ? (
              "Import"
            ) : screen === "direction" ? (
              "Set translation direction"
            ) : screen === "result" ? (
              "Import complete — some items skipped"
            ) : screen === "collision" ? (
              "Re-import detected"
            ) : screen === "preview" ? (
              <div className="flex items-center gap-2">
                <ImportDialogBackButton
                  onClick={() => {
                    const returnScreen = previewState?.returnScreen ?? "upload"
                    setPreviewState(null)
                    setPreviewCommitError(null)
                    setScreen(returnScreen)
                  }}
                  label="Back to file selection"
                />
                Preview
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <ImportDialogBackButton
                  onClick={() => setScreen("landing")}
                  label="Back to import types"
                />
                {screen === "upload" ? "Upload Files"
                  : screen === "helloao" ? "Bible API (helloao.org)"
                  : screen === "obs" ? "Open Bible Stories"
                  : screen === "dcs" ? "Door43 (DCS)"
                  : screen === "macula" ? "Macula Hebrew + Greek"
                  : screen === "tn" ? "Translation Notes (TSV)"
                  : screen === "spreadsheet" ? "Spreadsheet (CSV / XLSX)"
                  : screen === "labels" ? "Cell Labels / Cast"
                  : screen === "paired" ? "Paired Translation Import"
                  : screen === "sdbh" ? "SDBH Hebrew Lexicon"
                  : "eBible Corpus"}
              </div>
            )}
          </DialogTitle>
        </DialogHeader>

        <DialogBody>

        {screen === "landing" && (
          <ImportLanding
            allowDcs={patchDcsCursor !== undefined}
            onSelect={(s) => {
              posthog.capture(IMPORT_STARTED, { import_type: s, project_id: projectId })
              if (s === "spreadsheet") {
                setSpreadsheetSeedFile(null)
                setSpreadsheetReturnScreen("landing")
              }
              setScreen(s)
            }}
          />
        )}

        {screen === "upload" && (
          <UploadPanel
            projectId={projectId}
            username={username}
            sourceLanguage={sourceLanguage}
            targetLanguage={targetLanguage}
            targetLang={targetLang}
            identityToken={identityToken}
            getToken={getToken}
            ttsSettings={ttsSettings}
            onCastUpdated={onCastUpdated}
            existingFiles={existingFiles}
            onCollision={(collisions, proceed) => {
              posthog.capture(IMPORT_COLLISION_DETECTED, {
                collision_count: collisions.length,
                project_id: projectId,
              })
              setCollisionState({ collisions, proceed })
              setScreen("collision")
            }}
            onPreview={(results, commit) => {
              setPreviewUploadPhase("")
              setPreviewUploadProgress(null)
              setPreviewCommitError(null)
              setPreviewState({ results, commit, returnScreen: "upload" })
              setScreen("preview")
            }}
            onSpreadsheetFile={(file) => {
              setSpreadsheetSeedFile(file)
              setSpreadsheetReturnScreen("upload")
              setScreen("spreadsheet")
            }}
            onCommitPhase={setPreviewUploadPhase}
            onCommitProgress={setPreviewUploadProgress}
            onCommitError={setPreviewCommitError}
            onImported={handleChildImported}
            excludeFrontMatter={excludeFrontMatter}
          />
        )}

        {screen === "ebible" && (
          <EBiblePanel
            projectId={projectId}
            username={username}
            sourceLanguage={sourceLanguage}
            targetLanguage={targetLanguage}
            targetLang={targetLang}
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

        {screen === "helloao" && (
          <HelloaoPanel
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

        {screen === "obs" && (
          <ObsPanel
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

        {screen === "dcs" && patchDcsCursor && (
          <DcsPanel
            projectId={projectId}
            getToken={getToken}
            defaultLang={sourceLanguage}
            patchDcsCursor={patchDcsCursor}
            onImported={async (refs, inferredLanguages, skipped) => {
              await handleChildImported(refs, inferredLanguages, skipped)
            }}
            excludeFrontMatter={excludeFrontMatter}
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

        {screen === "sdbh" && (
          <SdbhPanel
            projectId={projectId}
            username={username}
            getToken={getToken}
            onImported={async (refs, inferredLanguages, skipped) => {
              await handleChildImported(refs, inferredLanguages, skipped)
            }}
          />
        )}

        {/* AQU-316: Spreadsheet importer (CSV / XLSX) with on-the-fly column mapping */}
        {screen === "spreadsheet" && (
          <SpreadsheetImportPanel
            projectId={projectId}
            username={username}
            sourceLanguage={sourceLanguage}
            targetLanguage={targetLanguage}
            targetLang={targetLang}
            getToken={getToken}
            ttsSettings={ttsSettings}
            onCastUpdated={onCastUpdated}
            onPreview={(results, commit) => {
              setPreviewUploadPhase("")
              setPreviewUploadProgress(null)
              setPreviewCommitError(null)
              setPreviewState({ results, commit, returnScreen: "spreadsheet" })
              setScreen("preview")
            }}
            onCommitError={setPreviewCommitError}
            onImported={async (refs) => {
              await handleChildImported(refs)
            }}
            initialFile={spreadsheetSeedFile}
            onCancel={() => {
              setSpreadsheetSeedFile(null)
              setScreen(spreadsheetReturnScreen)
            }}
          />
        )}

        {/* AQU-314: Cell labels / cast import via downloadable template */}
        {screen === "labels" && projectFiles && projectFiles.length > 0 && (
          <LabelImportPanel
            projectId={projectId}
            username={username}
            files={projectFiles}
            defaultFileId={activeFileId}
            getToken={getToken}
            onImported={(result) => {
              onOpenChange(false)
              onLabelsImported?.(result)
            }}
            onCancel={() => setScreen("landing")}
          />
        )}
        {screen === "labels" && (!projectFiles || projectFiles.length === 0) && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            Cell labels require an existing source file in this project. Import source files first, then return here.
          </div>
        )}

        {/* AQU-315: Paired source+target import (translation memory) */}
        {screen === "paired" && sourceCells && sourceCells.length > 0 && (
          <PairedImportPanel
            projectId={projectId}
            username={username}
            targetLang={targetLang}
            sourceCells={sourceCells}
            getToken={getToken}
            onImported={(committedCount) => {
              posthog.capture(IMPORT_SUCCEEDED, { file_count: committedCount, project_id: projectId })
              onOpenChange(false)
            }}
            onCancel={() => setScreen("landing")}
          />
        )}
        {screen === "paired" && (!sourceCells || sourceCells.length === 0) && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            Paired translation import requires existing source cells in this project. Import source files first.
          </div>
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

        {/* AQU-277: partial-import result screen */}
        {screen === "result" && importResult && (
          <ImportResultPanel
            importedCount={importResult.refs.length}
            skipped={importResult.skipped}
            onDismiss={handleResultDismiss}
            error={importResultError}
          />
        )}

        {/* AQU-310: preview — parsed cells waiting for user confirmation before upload */}
        {/* AQU-430: uploadPhase/uploadProgress surfaced from UploadPanel.doCommit */}
        {screen === "preview" && previewState && (
          <PreviewPanel
            results={previewState.results}
            onConfirm={async () => {
              setPreviewCommitError(null)
              await previewState.commit()
            }}
            onCancel={() => {
              const returnScreen = previewState.returnScreen
              setPreviewState(null)
              setPreviewCommitError(null)
              setScreen(returnScreen)
            }}
            uploadPhase={previewUploadPhase}
            uploadProgress={previewUploadProgress}
            error={previewCommitError}
          />
        )}

        {/* AQU-287: collision guard — shown when re-importing into an existing project */}
        {screen === "collision" && collisionState && (
          <CollisionPanel
            collisions={collisionState.collisions}
            onResolve={async (resolution) => {
              const totalCount = collisionState.collisions.length
              const skippedCount = resolution.skipKeys.size
              const updatedCount = resolution.reimportFileIds.size
              const duplicatedCount = totalCount - skippedCount - updatedCount
              if (skippedCount > 0) {
                posthog.capture(IMPORT_COLLISION_SKIPPED, {
                  skipped_count: skippedCount,
                  duplicated_count: duplicatedCount,
                  updated_count: updatedCount,
                  project_id: projectId,
                })
              } else {
                posthog.capture(IMPORT_COLLISION_DUPLICATED, {
                  duplicated_count: duplicatedCount,
                  updated_count: updatedCount,
                  project_id: projectId,
                })
              }
              setCollisionState(null)
              setScreen("upload")
              await collisionState.proceed(resolution)
            }}
            onCancel={() => {
              setCollisionState(null)
              setScreen("upload")
            }}
          />
        )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Beta badge — mirrors codex-editor's convention of flagging not-ready importers.
// AQU-310: shown on Macula and Translation Notes importers.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Import landing — grouped, scannable chooser
//
// Mirrors codex-editor's NewSourceUploader: two goal-named tiers (the formats
// most projects start with, then domain-specific workflows) instead of a flat
// wall of nine equally-weighted cards. Each option leads with an icon and a
// single-line purpose so the chooser scans fast. Built from shadcn Card/Badge
// so it inherits the app theme.
// ---------------------------------------------------------------------------

type ImportOption = {
  /** Screen to route to on select. Omitted for not-yet-available options. */
  id?: Screen
  title: string
  /** Short qualifier shown in lighter weight after the title. */
  hint?: string
  description: string
  icon: LucideIcon
  badge?: "beta" | "soon"
  disabled?: boolean
}

const POPULAR_OPTIONS: ImportOption[] = [
  { id: "upload", title: "Upload files", icon: Upload,
    description: "USFM, DOCX, PPTX, IDML, TXT, subtitles, spreadsheets, audio/video, or a Paratext project." },
  { id: "ebible", title: "eBible Corpus", hint: "public library", icon: Library,
    description: "Openly-licensed Bible translations, imported directly — no download." },
  { id: "helloao", title: "Bible API", hint: "helloao.org", icon: Globe,
    description: "1,000+ translations — the whole Bible, one testament, or just the books you pick." },
  { id: "spreadsheet", title: "Spreadsheet", hint: "CSV / XLSX", icon: Table2, badge: "beta",
    description: "Map which columns are source, target, label, cast, or timestamp." },
]

const SPECIALIZED_OPTIONS: ImportOption[] = [
  { id: "macula", title: "Macula Hebrew + Greek", icon: Languages, badge: "beta",
    description: "Original-language OT/NT with per-word lemma, morphology, and Strong's." },
  { id: "paired", title: "Paired translation", icon: ArrowLeftRight, badge: "beta",
    description: "Source + target pairs from a spreadsheet to fill the target column." },
  { id: "labels", title: "Cell labels / cast", icon: Tags, badge: "beta",
    description: "Re-upload a template to label existing cells with cast names." },
  { id: "tn", title: "Translation Notes", hint: "TSV", icon: StickyNote, badge: "beta",
    description: "unfoldingWord notes, shown beside the matching verse as you translate." },
  { id: "obs", title: "Open Bible Stories", hint: "door43", icon: BookImage, badge: "beta",
    description: "Narrative stories with reference images, from unfoldingWord/door43." },
  { id: "dcs", title: "Door43 (DCS)", hint: "upstream", icon: Cloud, badge: "beta",
    description: "Import any released Door43 resource as source and pin it to a release — pull upstream changes later." },
  { id: "sdbh", title: "SDBH Hebrew Lexicon", hint: "UBS MARBLE", icon: BookA, badge: "beta",
    description: "Semantic Dictionary of Biblical Hebrew — localize definitions and glosses by semantic domain, with lossless export back to the MARBLE XML." },
  { id: "upload", title: "Translation Memory", hint: "TMX", icon: Database,
    description: "Import source/target pairs from a TMX memory file." },
]

function OptionBadge({ kind }: { kind: "beta" | "soon" }) {
  if (kind === "soon") {
    return <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">Soon</Badge>
  }
  return (
    <Badge
      variant="secondary"
      className="border border-amber-200 bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-400"
    >
      Beta
    </Badge>
  )
}

function OptionCard({ option, onSelect }: { option: ImportOption; onSelect: (s: Screen) => void }) {
  const { icon: Icon, disabled } = option
  const select = () => { if (!disabled && option.id) onSelect(option.id) }
  const disabledTooltip = disabled
    ? `Coming soon — ${option.title} import is tracked for a later release`
    : undefined
  const testTooltipAttr = import.meta.env.MODE === "test" ? disabledTooltip : undefined
  const card = (
    <Card
      size="sm"
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      data-tooltip={testTooltipAttr}
      onClick={select}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select() }
      }}
      className={cn(
        "gap-0 px-3",
        disabled
          ? "cursor-not-allowed opacity-55"
          : "cursor-pointer transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium leading-none">{option.title}</span>
            {option.hint && <span className="text-xs text-muted-foreground">{option.hint}</span>}
            {option.badge && <span className="ml-auto shrink-0"><OptionBadge kind={option.badge} /></span>}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{option.description}</p>
        </div>
      </div>
    </Card>
  )

  if (!disabled) return card

  return <AppTooltip content={disabledTooltip}>{card}</AppTooltip>
}

function ImportSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="px-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">{label}</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>
    </div>
  )
}

interface ImportLandingProps {
  onSelect: (screen: Screen) => void
  /** When false, the Door43 (DCS) option is hidden — its import needs a way to
   *  write the project settings cursor (patchDcsCursor), unavailable e.g. for
   *  unsynced local-only projects. */
  allowDcs: boolean
}

function ImportLanding({ onSelect, allowDcs }: ImportLandingProps) {
  // The specialized tier is a growing catalogue of domain-specific importers —
  // filterable so it stays scannable as entries accumulate.
  const [filter, setFilter] = useState("")
  const q = filter.trim().toLowerCase()
  // Hide DCS when the host can't persist the release cursor.
  const available = allowDcs
    ? SPECIALIZED_OPTIONS
    : SPECIALIZED_OPTIONS.filter((o) => o.id !== "dcs")
  const specialized = q
    ? available.filter((o) =>
        [o.title, o.hint ?? "", o.description].some((t) => t.toLowerCase().includes(q)),
      )
    : available
  return (
    <div className="space-y-5 py-1">
      <p className="text-sm text-muted-foreground">Choose the format that matches your files.</p>
      <ImportSection label="Most popular">
        {POPULAR_OPTIONS.map((o) => (
          <OptionCard key={o.title} option={o} onSelect={onSelect} />
        ))}
      </ImportSection>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="px-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">Specialized</h3>
          <InputGroup className="h-7 w-44">
            <InputGroupAddon>
              <Search className="text-muted-foreground/60" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter importers…"
              aria-label="Filter specialized importers"
              className="text-xs placeholder:text-muted-foreground/60"
            />
          </InputGroup>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {specialized.map((o) => (
            <OptionCard key={o.title} option={o} onSelect={onSelect} />
          ))}
          {specialized.length === 0 && (
            <p className="col-span-full px-0.5 py-2 text-xs text-muted-foreground">
              No importer matches “{filter}”.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

interface UploadPanelProps {
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

function idmlParsePhase(
  fileName: string,
  progress: { phase: string; completed: number; total: number },
): string {
  const action = progress.phase === "inspect"
    ? "Checking"
    : progress.phase === "unpack"
      ? "Opening"
      : "Reading"
  const count = progress.total > 1
    ? ` (${Math.min(progress.completed, progress.total)}/${progress.total})`
    : ""
  return `${action} ${fileName}${count}…`
}

function UploadPanel({ projectId, username, sourceLanguage, targetLanguage, targetLang, identityToken, getToken, onImported, ttsSettings, onCastUpdated, existingFiles, onCollision, onPreview, onCommitPhase, onCommitProgress, onCommitError, onSpreadsheetFile, excludeFrontMatter }: UploadPanelProps) {
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string>("")
  const [progress, setProgress] = useState<ImportUploadProgress | null>(null)
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
    [projectId, username, sourceLanguage, targetLanguage, targetLang, identityToken, getToken, onImported, ttsSettings, onCastUpdated, existingFiles, onCollision]
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
          setError("Import one spreadsheet at a time so its columns can be mapped safely.")
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
            setPhase(knownType ? `Reading ${file.name}…` : `Analyzing ${file.name}…`)
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
          setError(err instanceof Error ? err.message : "Parse failed")
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
    [projectId, username, sourceLanguage, targetLanguage, identityToken, getToken, onImported, ttsSettings, onCastUpdated, onPreview, onSpreadsheetFile]
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
        const finishPhase = "Finishing up…"
        setPhase(finishPhase)
        onCommitPhase?.(finishPhase)
        try {
          await onImported(checkpoint.refs, undefined, checkpoint.skipped)
          finalizationCheckpointRef.current = null
        } catch (err) {
          const message = err instanceof Error ? err.message : "Import finalization failed"
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
          const filePhase = `Uploading ${file.name}…`
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
            getToken,
            onCellEnqueued: (count, total) => {
              const p = `Uploading ${file.name}`
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
        const finishPhase = "Finishing up…"
        setPhase(finishPhase)
        onCommitPhase?.(finishPhase)
        handoffAttempted = true
        const skipped = allSkipped.length ? allSkipped : undefined
        finalizationCheckpointRef.current = { files: list, refs: allRefs, skipped }
        await onImported(allRefs, undefined, skipped)
        finalizationCheckpointRef.current = null
      } catch (err) {
        const message = err instanceof Error ? err.message : "Import failed"
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
              reason: index === 0 ? message : "not attempted after an earlier file failed",
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
                book: "Cast assignments",
                reason: castError instanceof Error ? castError.message : String(castError),
              })
            }
          }
          if (failedAndUnattempted.length === 0) {
            failedAndUnattempted.push({ book: "Import finalization", reason: message })
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
            const handoffMessage = handoffError instanceof Error ? handoffError.message : "Import finalization failed"
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
        setImporting(false)
        setProgress(null)
        onCommitProgress?.(null)
        setPhase("")
        onCommitPhase?.("")
      }
    },
    [projectId, username, sourceLanguage, targetLanguage, targetLang, identityToken, getToken, onImported, ttsSettings, onCastUpdated, onCommitPhase, onCommitProgress, onCommitError]
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
                {progress.bytesTotal ? (
                  <>
                    {" · "}
                    <span data-testid="upload-bytes">
                      {formatBytesProgress(progress.bytesReceived, progress.bytesTotal)}
                    </span>
                  </>
                ) : null}
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
            <p><span className="font-medium text-foreground/70">Documents</span> — DOCX, TXT, MD, HTML, JSON/ARB, PPTX, IDML (InDesign)</p>
            <p><span className="font-medium text-foreground/70">Localization</span> — PO/POT, Java properties</p>
            <p><span className="font-medium text-foreground/70">Subtitles</span> — VTT, SRT, SBV</p>
            <p><span className="font-medium text-foreground/70">Paratext project</span> — .zip or folder</p>
            <p><span className="font-medium text-foreground/70">Other formats</span> — AI-assisted when configured, always reviewed before import</p>
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
  targetLang?: string
  getToken: (fileId: string) => Promise<string | null>
  /** AQU-277: third argument carries skipped books from a partial import so the
   *  parent can show the result screen before closing. */
  onImported: (refs: FileReference[], inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }, skipped?: { book: string; reason: string }[]) => void | Promise<void>
  onCancel: () => void
  /** AQU-287: files already in the project; used for collision detection. */
  existingFiles?: { id?: string; name: string; bookCode?: string }[]
  /** AQU-287: called when collisions are detected before running the import. */
  onCollision?: (collisions: CollisionResult[], proceed: (resolution: CollisionResolution) => void | Promise<void>) => void
  /** AQU-634: per-project USFM front-matter opt-out (forwarded to
   *  prepareParatextProject). */
  excludeFrontMatter?: boolean
}

/** Preview + source-vs-target choice for a detected Paratext project (AQU-310:
 *  everything parses client-side up front; nothing uploads until the user
 *  confirms). Source imports the books as a reference text; target pairs the
 *  consultant's in-progress translation against an eBible source picked here
 *  (aligned by verse ref). */
function ParatextChoice({
  entries, bookCount, projectId, username, sourceLanguage, targetLanguage, targetLang, getToken, onImported, onCancel,
  existingFiles, onCollision, excludeFrontMatter,
}: ParatextChoiceProps) {
  const [mode, setMode] = useState<"choose" | "pickSource" | "importing">("choose")
  const [plan, setPlan] = useState<ParatextPlan | null>(null)
  const [phase, setPhase] = useState("")
  const [progress, setProgress] = useState<{ count: number; total: number; bookLabel: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [translations, setTranslations] = useState<EBibleTranslation[] | null>(null)
  const [query, setQuery] = useState("")
  // Books the user unchecked in the preview (uppercase bookIds → skipKeys).
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())
  const [expandedBook, setExpandedBook] = useState<string | null>(null)

  const ctx = { projectId, author: username, sourceLanguage, targetLanguage, targetLang, getToken }

  // AQU-310: parse the whole project client-side on mount — fast (no network),
  // so the preview appears immediately and the user confirms before any upload.
  useEffect(() => {
    let cancelled = false
    prepareParatextProject(entries, { excludeFrontMatter })
      .then((p) => { if (!cancelled) setPlan(p) })
      .catch((err) => {
        if (cancelled) return
        posthog.captureException(err, { import_stage: "paratext-parse", project_id: projectId })
        posthog.capture(IMPORT_FAILED, {
          import_stage: "paratext-parse",
          project_id: projectId,
          error_message: err instanceof Error ? err.message : String(err),
        })
        setError(err instanceof Error ? err.message : "Couldn't read the project")
      })
    return () => { cancelled = true }
  }, [entries, projectId, excludeFrontMatter])

  function onProgress(p: ParatextImportProgress) {
    const bookLabel = p.book
      ? `${p.book} · book ${Math.min(p.booksDone + 1, p.booksTotal)} of ${p.booksTotal}`
      : `${p.booksDone} / ${p.booksTotal} books`
    setPhase(p.book ? `Uploading ${p.book}…` : "Uploading…")
    // Prefer the per-chunk cell counts (smooth bar); fall back to books.
    if (p.cellsTotal != null && p.cellsTotal > 0) {
      setProgress({ count: p.cellsDone ?? 0, total: p.cellsTotal, bookLabel })
    } else {
      setProgress({ count: p.booksDone, total: p.booksTotal, bookLabel })
    }
  }

  /** Preview exclusions + collision-prompt skips, merged. */
  function mergedSkipKeys(collisionSkips: ReadonlySet<string>): ReadonlySet<string> {
    return new Set([...excluded, ...collisionSkips])
  }

  /** Collision candidates: included books only, from the parsed plan. */
  function detectPlanCollisions(p: ParatextPlan): CollisionResult[] {
    if (!existingFiles || existingFiles.length === 0) return []
    const incoming = p.books
      .filter((b) => !excluded.has(b.book.bookId.toUpperCase()))
      .map((b) => ({ name: b.book.displayName, bookCode: b.book.bookId }))
    return detectCollisions(incoming, existingFiles)
  }

  async function runSourceWithResolution(resolution: CollisionResolution) {
    if (!plan) return
    setMode("importing"); setError(null); setPhase("Uploading…"); setProgress(null)
    try {
      const { refs, settings, skipped } = await commitParatextProject(plan, {
        ...ctx,
        skipKeys: mergedSkipKeys(resolution.skipKeys),
        reimportFileIds: resolution.reimportFileIds,
      }, onProgress)
      const inferredLang = settings.languageIsoCode || settings.language
      await onImported(refs, inferredLang ? { sourceLanguage: inferredLang } : undefined, skipped.length ? skipped : undefined)
    } catch (err) {
      posthog.captureException(err, { import_stage: "paratext-upload", project_id: projectId })
      posthog.capture(IMPORT_FAILED, {
        import_stage: "paratext-upload",
        project_id: projectId,
        error_message: err instanceof Error ? err.message : String(err),
      })
      setError(err instanceof Error ? err.message : "Import failed"); setMode("choose")
    }
  }

  async function runSource() {
    if (!plan) return
    // AQU-287: collision check before running the import.
    if (onCollision) {
      const collisions = detectPlanCollisions(plan)
      if (collisions.length > 0) {
        onCollision(collisions, runSourceWithResolution)
        return
      }
    }
    await runSourceWithResolution({ skipKeys: new Set(), reimportFileIds: new Map() })
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

  async function runTargetWithResolution(sel: EBibleTranslation, resolution: CollisionResolution) {
    if (!plan) return
    setMode("importing"); setError(null); setPhase(`Fetching source: ${sel.title}…`); setProgress(null)
    try {
      const corpus = await fetchTranslationText(sel.id, () => {})
      const sourceVerses: SourceVerse[] = parseEBibleCorpus(corpus).map((s) => ({
        ref: s.globalReferences?.[0] ?? s.context,
        text: s.original,
      }))
      const selSourceLang = sel.languageCode || sel.id
      const { refs, settings, skipped } = await importParatextAsTarget(plan, sourceVerses, {
        ...ctx,
        sourceLanguage: selSourceLang,
        skipKeys: mergedSkipKeys(resolution.skipKeys),
        reimportFileIds: resolution.reimportFileIds,
      }, onProgress)
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
    if (!plan) return
    // AQU-287: collision check before fetching source corpus.
    if (onCollision) {
      const collisions = detectPlanCollisions(plan)
      if (collisions.length > 0) {
        onCollision(collisions, (resolution) => runTargetWithResolution(sel, resolution))
        return
      }
    }
    await runTargetWithResolution(sel, { skipKeys: new Set(), reimportFileIds: new Map() })
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
            <p className="mt-1.5 text-xs text-muted-foreground">
              {progress.count.toLocaleString()} / {progress.total.toLocaleString()} cells · {progress.bookLabel}
            </p>
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
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search translations (language, name, code)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search translations"
          />
        </InputGroup>
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

  // Preview screen (AQU-310): everything below is parsed, nothing is uploaded.
  const includedBooks = plan?.books.filter((b) => !excluded.has(b.book.bookId.toUpperCase())) ?? []
  const includedCells = includedBooks.reduce((n, b) => n + b.cellCount, 0)
  const language = plan ? (plan.project.settings.language || plan.project.settings.languageIsoCode || "") : ""

  function toggleBook(bookId: string) {
    const key = bookId.toUpperCase()
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      <div>
        <p className="text-sm font-medium">
          Paratext project detected — {plan ? plan.books.length : bookCount} book{(plan ? plan.books.length : bookCount) === 1 ? "" : "s"}
        </p>
        <p className="text-xs text-muted-foreground">
          {plan
            ? <>{language && <>Language: {language} · </>}{includedCells.toLocaleString()} cells parsed in your browser — review, then choose how to bring it in.</>
            : "Reading project…"}
        </p>
      </div>
      {plan && (
        // Native overflow scroll: ScrollArea's size-full viewport can't resolve
        // against a max-h-only root, so long book lists paint past the border.
        <div className="max-h-56 overflow-y-auto rounded border">
          <ul className="divide-y">
            {plan.books.map((b) => {
              const key = b.book.bookId.toUpperCase()
              const included = !excluded.has(key)
              const expanded = expandedBook === key
              return (
                <li key={key}>
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <Checkbox
                      checked={included}
                      onCheckedChange={() => toggleBook(b.book.bookId)}
                      aria-label={`Include ${b.book.displayName}`}
                    />
                    <button
                      type="button"
                      onClick={() => setExpandedBook(expanded ? null : key)}
                      className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                      aria-label="Show the first parsed cells"
                    >
                      <span className={`truncate text-sm ${included ? "" : "text-muted-foreground line-through"}`}>{b.book.displayName}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {b.book.bookId} · {b.cellCount.toLocaleString()} cells
                        {b.duplicateRefs.length > 0 && <span className="text-amber-600"> · {b.duplicateRefs.length} duplicate ref{b.duplicateRefs.length === 1 ? "" : "s"}</span>}
                      </span>
                    </button>
                  </div>
                  {expanded && (
                    <ul className="space-y-1 px-3 pb-2 pl-9">
                      {b.strings.slice(0, 4).map((s) => (
                        <li key={s.id} className="truncate text-xs text-muted-foreground">
                          {/* AQU-580: Paratext books are raw USFM — strip the
                              intra-cell markers (\add, \nd, \f…\f*, \w…\w*, …)
                              for the preview so translators never see backslash
                              codes. Stored cell text (s.original) is untouched;
                              only this display is cleaned. */}
                          <span className="font-medium">{s.context}</span> {usfmDisplayText(s.original)}
                        </li>
                      ))}
                      {b.strings.length > 4 && (
                        <li className="text-xs text-muted-foreground/70">… {(b.strings.length - 4).toLocaleString()} more</li>
                      )}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">How should we bring it in?</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button type="button" onClick={runSource} disabled={!plan || includedBooks.length === 0} className="rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50">
          <p className="text-sm font-medium">Source text</p>
          <p className="mt-1 text-xs text-muted-foreground">A reference Bible to translate from. Books import as source cells.</p>
        </button>
        <button type="button" onClick={startTarget} disabled={!plan || includedBooks.length === 0} className="rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50">
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

function EBiblePanel({ projectId, username, sourceLanguage, targetLanguage, targetLang, getToken, sourceCells, onImported, onTargetImported }: EBiblePanelProps) {
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
      // sourceLanguage so the project can seed it when unset (AQU-249).
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
        { projectId, author: username, getToken, targetLang },
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
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as EBiblePanelMode)}
          className="gap-0"
        >
          <TabsList size="lg" className="w-full" aria-label="eBible import mode">
            <TabsTrigger value="source">New source file</TabsTrigger>
            <TabsTrigger value="target">Into target column</TabsTrigger>
          </TabsList>
        </Tabs>
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

      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="Search by language, title, or id (e.g. 'eng', 'KJV')"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!translations || importing}
          aria-label="Search eBible translations"
        />
      </InputGroup>

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
// Hello AO Free Use Bible API panel — pick a translation, then choose books
// (whole bible / testament / per-book), then import. One bulk complete.json
// request per import; selection filters client-side (never per-chapter calls).
// ---------------------------------------------------------------------------

interface HelloaoPanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference, inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }) => void | Promise<void>
}

function HelloaoPanel({ projectId, username, sourceLanguage, targetLanguage, getToken, onImported }: HelloaoPanelProps) {
  const [translations, setTranslations] = useState<HelloaoTranslation[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<HelloaoTranslation | null>(null)

  // Book-selection step: loaded when a translation is chosen.
  const [books, setBooks] = useState<HelloaoBook[] | null>(null)
  const [booksErr, setBooksErr] = useState<string | null>(null)
  const [checkedBooks, setCheckedBooks] = useState<Set<string>>(new Set())

  const [progress, setProgress] = useState<EBibleProgress | null>(null)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchHelloaoTranslations()
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

  // Cancel any in-flight download when panel unmounts (e.g. dialog closed)
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const filtered = useMemo(() => {
    if (!translations) return []
    const q = query.trim().toLowerCase()
    if (!q) return translations.slice(0, 200)
    return translations
      .filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.englishName.toLowerCase().includes(q) ||
          t.languageEnglishName.toLowerCase().includes(q) ||
          t.languageName.toLowerCase().includes(q)
      )
      .slice(0, 200)
  }, [translations, query])

  function handleSelect(t: HelloaoTranslation) {
    setSelected(t)
    setBooks(null)
    setBooksErr(null)
    setCheckedBooks(new Set())
    fetchHelloaoBooks(t.id)
      .then((list) => {
        setBooks(list)
        // Default: everything selected (whole bible).
        setCheckedBooks(new Set(list.map((b) => b.id)))
      })
      .catch((err) => {
        setBooksErr(err instanceof Error ? err.message : String(err))
      })
  }

  function applyPreset(preset: "all" | "OT" | "NT") {
    if (!books) return
    if (preset === "all") {
      setCheckedBooks(new Set(books.map((b) => b.id)))
    } else {
      setCheckedBooks(new Set(books.filter((b) => getTestament(b.id) === preset).map((b) => b.id)))
    }
  }

  function toggleBook(id: string) {
    setCheckedBooks((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleImport() {
    if (!selected || !books || checkedBooks.size === 0 || importing) return
    setImporting(true)
    setImportErr(null)
    setProgress({ phase: "download", received: 0, total: 0 })
    abortRef.current = new AbortController()

    try {
      // Whole-bible selection passes null so the parser skips no books.
      const selection = checkedBooks.size === books.length ? null : checkedBooks
      const ref = await importHelloao(
        selected,
        selection,
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
      await onImported(ref, { sourceLanguage: selected.language || undefined })
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImporting(false)
      abortRef.current = null
    }
  }

  const selectedVerseCount = useMemo(() => {
    if (!books) return 0
    return books.reduce((sum, b) => sum + (checkedBooks.has(b.id) ? b.totalNumberOfVerses : 0), 0)
  }, [books, checkedBooks])

  // ── Book-selection step ─────────────────────────────────────────────────────
  if (selected) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ImportDialogBackButton
            disabled={importing}
            onClick={() => setSelected(null)}
            label="Back to translation list"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{selected.englishName || selected.name}</p>
            <p className="text-xs text-muted-foreground">
              {selected.languageEnglishName || selected.languageName} ·{" "}
              <a href={selected.licenseUrl} target="_blank" rel="noreferrer" className="underline">
                license
              </a>
            </p>
          </div>
        </div>

        {booksErr ? (
          <p className="text-sm text-destructive">Failed to load books: {booksErr}</p>
        ) : !books ? (
          <p className="text-sm text-muted-foreground">Loading books…</p>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <ButtonGroup>
                <Button size="sm" variant="outline" disabled={importing} onClick={() => applyPreset("all")}>
                  Whole bible
                </Button>
                <Button size="sm" variant="outline" disabled={importing} onClick={() => applyPreset("OT")}>
                  Old Testament
                </Button>
                <Button size="sm" variant="outline" disabled={importing} onClick={() => applyPreset("NT")}>
                  New Testament
                </Button>
              </ButtonGroup>
              <span className="ml-auto text-xs text-muted-foreground">
                {checkedBooks.size} of {books.length} books
              </span>
            </div>

            <ScrollArea className="h-64 rounded-md border">
              <ul className="grid grid-cols-2 gap-x-2 p-2 sm:grid-cols-3">
                {books.map((b) => (
                  <li key={b.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
                      <Checkbox
                        checked={checkedBooks.has(b.id)}
                        disabled={importing}
                        onCheckedChange={() => toggleBook(b.id)}
                      />
                      <span className="truncate">{b.commonName || b.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </>
        )}

        {progress && (
          <div className="text-xs text-muted-foreground">
            <p>
              {progress.phase === "download"
                ? `Downloading ${selected.id}… ${formatProgress(progress.received, progress.total)}`
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

        <div className="flex items-center justify-end gap-3">
          {books && checkedBooks.size > 0 && (
            <span className="text-xs text-muted-foreground">
              ~{selectedVerseCount.toLocaleString()} verses
            </span>
          )}
          <Button onClick={handleImport} disabled={!books || checkedBooks.size === 0 || importing}>
            {importing ? "Importing..." : "Import"}
          </Button>
        </div>
      </div>
    )
  }

  // ── Translation picker step ─────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Import a Bible translation from the{" "}
        <a href="https://bible.helloao.org/docs/" target="_blank" rel="noreferrer" className="underline">
          Free Use Bible API
        </a>{" "}
        — over 1,000 versions with section headings and formatting. You can import the whole
        bible, a single testament, or individual books.
      </p>

      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="Search by language, name, or id (e.g. 'eng', 'BSB')"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!translations}
          aria-label="Search Bible translations"
        />
      </InputGroup>

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
            {filtered.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(t)}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="font-medium">{t.englishName || t.name}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {t.id}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t.languageEnglishName || t.languageName} · {t.numberOfBooks} books
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Direction prompt — shown once when source/target are ambiguous (AQU-249)
// ---------------------------------------------------------------------------

interface DirectionPanelProps {
  sourceLanguage: string
  targetLanguage: string
  onSourceChange: (v: string) => void
  onTargetChange: (v: string) => void
  onConfirm: () => void
  onSkip: () => void
  confirming?: boolean
  /** AQU-249: shown inline when onImported throws so the user can retry. */
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
      <FieldGroup className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor="dl-source">Source language</FieldLabel>
          <Input
            id="dl-source"
            value={sourceLanguage}
            onChange={(e) => onSourceChange(e.target.value)}
            placeholder="e.g. English, arb, hbo"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="dl-target">
            Target language <span className="text-destructive">*</span>
          </FieldLabel>
          <Input
            id="dl-target"
            value={targetLanguage}
            onChange={(e) => onTargetChange(e.target.value)}
            placeholder="e.g. Spanish, fra, swh"
            autoFocus
          />
        </Field>
      </FieldGroup>
      <p className="text-xs text-muted-foreground">
        You can change these later in <strong>Project Settings → Project Info</strong>.
      </p>
      {/* AQU-249: restore direction screen on failure so the user can retry */}
      {error && <FieldError role="alert">{error}</FieldError>}
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
// Import result panel — AQU-277
// Shows the full skip report after a partial Paratext import. The user must
// explicitly dismiss (or copy and then dismiss) before the dialog closes.
// ---------------------------------------------------------------------------

interface ImportResultPanelProps {
  importedCount: number
  skipped: { book: string; reason: string }[]
  onDismiss: () => void | Promise<void>
  error?: string | null
}

function ImportResultPanel({ importedCount, skipped, onDismiss, error }: ImportResultPanelProps) {
  const [copied, setCopied] = useState(false)
  const [dismissing, setDismissing] = useState(false)

  const reportText = [
    `Import complete: ${importedCount} item${importedCount === 1 ? "" : "s"} imported, ${skipped.length} skipped.`,
    "",
    "Skipped items:",
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
        <span className="font-medium text-foreground">{importedCount}</span> item{importedCount === 1 ? "" : "s"} imported
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
      {error ? <FieldError role="alert">{error}</FieldError> : null}
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
// Collision guard panel — AQU-287
// Shown when re-importing into a project that already has matching files.
// Offers safe identity-based update, Skip, or Import as duplicate per collision. Apply-to-all lets
// the user resolve the whole batch in one click.
// ---------------------------------------------------------------------------

type CollisionChoice = "update" | "skip" | "duplicate"

interface CollisionPanelProps {
  collisions: CollisionResult[]
  onResolve: (resolution: CollisionResolution) => void | Promise<void>
  onCancel: () => void
}

/** Per-collision prompt with apply-to-all toggle. */
function CollisionPanel({ collisions, onResolve, onCancel }: CollisionPanelProps) {
  // Updating preserves logical cell ids and is the safe default when the
  // existing project listing supplied an id. Legacy name-only callers fall
  // back to Skip because they cannot address an existing file safely.
  const [choices, setChoices] = useState<Map<string, CollisionChoice>>(() => {
    const m = new Map<string, CollisionChoice>()
    for (const c of collisions) m.set(c.name, c.existingId ? "update" : "skip")
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

  function setChoice(name: string, choice: CollisionChoice) {
    setChoices((prev) => {
      const next = new Map(prev)
      next.set(name, choice)
      return next
    })
  }

  async function handleConfirm() {
    if (resolving) return
    setResolving(true)
    try {
      // Build skipKeys: normalized keys for every item the user chose to skip.
      const skipKeys = new Set<string>()
      const reimportFileIds = new Map<string, string>()
      for (const [name, choice] of choices) {
        const collision = collisions.find((c) => c.name === name)
        const key = collision?.bookCode
          ? collision.bookCode.toUpperCase()
          : name.trim().toLowerCase()
        if (choice === "skip") {
          // Key must match what importFile / importParatextProject checks.
          // bookCode (uppercase) or normalized name (lowercase trimmed).
          skipKeys.add(key)
        } else if (choice === "update" && collision?.existingId) {
          reimportFileIds.set(key, collision.existingId)
        }
      }
      await onResolve({ skipKeys, reimportFileIds })
    } finally {
      setResolving(false)
    }
  }

  const allSkip = [...choices.values()].every((v) => v === "skip")
  const allDup = [...choices.values()].every((v) => v === "duplicate")
  const allUpdate = [...choices.values()].every((v) => v === "update")
  const canUpdateAll = collisions.every((collision) => collision.existingId)

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        The following {collisions.length === 1 ? "file already exists" : `${collisions.length} files already exist`} in this
        project. Choose what to do with each one.
      </p>
      <p className="text-xs text-muted-foreground">
        Updating matches stable units and keeps translations, language lanes, comments, audio, and units missing from the new file.
      </p>
      {collisions.some((collision) => collision.ambiguous) && (
        <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
          Some files have multiple matches. Choose Skip or Import as duplicate for those files.
        </p>
      )}

      {/* Apply-to-all row */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Apply to all:</span>
        <button
          type="button"
          onClick={() => setAll("update")}
          disabled={!canUpdateAll}
          className={cn(
            "rounded border px-2 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            allUpdate ? "border-primary bg-primary/10 text-primary" : "border-muted text-muted-foreground hover:border-foreground/40",
          )}
        >
          Update all
        </button>
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

      {/* Per-collision rows. Native overflow scroll — see PreviewPanel note on
          the ScrollArea max-h footgun. */}
      <div className="max-h-64 overflow-y-auto rounded-md border">
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
                {/* Explicit three-way resolution; update never replaces target data. */}
                <div className="flex shrink-0 gap-1 text-xs">
                  <button
                    type="button"
                    disabled={!c.existingId}
                    onClick={() => setChoice(c.name, "update")}
                    className={cn(
                      "rounded border px-2 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                      choice === "update"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted text-muted-foreground hover:border-foreground/40",
                    )}
                  >
                    Update existing
                  </button>
                  <button
                    type="button"
                    onClick={() => setChoice(c.name, "skip")}
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
                    onClick={() => setChoice(c.name, "duplicate")}
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
      </div>

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
// Open Bible Stories (OBS) panel — one-click download of English OBS from
// unfoldingWord/door43. Each frame becomes a cell carrying its reference image
// in metadata.attachments. Flows through the SAME bulk path as importEBible.
// ---------------------------------------------------------------------------

interface ObsPanelProps {
  projectId: string
  username: string
  sourceLanguage: string
  targetLanguage: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference, inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string }) => void | Promise<void>
}

function ObsPanel({ projectId, username, sourceLanguage, targetLanguage, getToken, onImported }: ObsPanelProps) {
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
              ? `Downloading stories… ${formatProgress(progress.received, progress.total)}`
              : progress.phase === "parse"
                ? "Parsing frames…"
                : progress.cellsTotal
                  ? `Uploading frames: ${(progress.cellsEnqueued ?? 0).toLocaleString()} / ${progress.cellsTotal.toLocaleString()}`
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

// ---------------------------------------------------------------------------
// Door43 (DCS) panel — the catalog browser + import-as-source flow (spec §9).
// Browse released Door43 resources, pick one, import it into the CURRENT
// project as source cells via the DCS adapter (importDcsResource → the same
// bulkUploadSource front door the other importers use), then pin the project
// to that release by writing the `dcsUpstream` cursor to project settings.
// This turns the current project into a DCS-linked source/"adapter" project;
// downstream language projects link to it via the existing linked-projects
// create flow (NOT built here).
// ---------------------------------------------------------------------------

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

function DcsPanel({ projectId, getToken, defaultLang, patchDcsCursor, onImported, excludeFrontMatter }: DcsPanelProps) {
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
              {progress.uploaded.toLocaleString()} / {progress.total.toLocaleString()} files
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
            {summary.files.toLocaleString()} file{summary.files === 1 ? "" : "s"} ·{" "}
            {summary.cells.toLocaleString()} cell{summary.cells === 1 ? "" : "s"}
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

// ---------------------------------------------------------------------------
// SDBH Hebrew Lexicon panel — UBS MARBLE editions. The master (usually
// English) edition supplies structure + source text; an optional localized
// edition pre-fills the target column. Cell ids are the shared LEXIDs, so the
// localization can later be exported losslessly back into the MARBLE XML.
// ---------------------------------------------------------------------------

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

function SdbhPanel({ projectId, username, getToken, onImported }: SdbhPanelProps) {
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
        <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer" />}>
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
        <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer" />}>
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
                  ? `: ${(progress.cellsEnqueued ?? 0).toLocaleString()} / ${progress.cellsTotal.toLocaleString()} cells`
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

// ---------------------------------------------------------------------------
// Macula Hebrew + Greek panel (AQU-178)
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
// Translation Notes (TSV) panel (AQU-179)
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

function ImportDialogBackButton({
  label,
  onClick,
  disabled,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className="-ml-2"
    >
      <ArrowLeft />
    </Button>
  )
}

// AQU-520: byte-transfer progress is formatted by the shared `formatBytesProgress`
// helper (src/lib/format-bytes.ts) — kept as a thin alias so the download-phase
// call sites below read the same and the behaviour is unit-tested in one place.
const formatProgress = formatBytesProgress
