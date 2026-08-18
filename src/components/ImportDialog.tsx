import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Upload, Library, Globe, Table2, Languages, ArrowLeft, ArrowLeftRight, Tags, StickyNote, Database,
  BookImage, BookA, BookOpen, Search, Cloud, CloudDownload,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
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
  OptionalMark,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SegmentTabs, Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import { t as tStandalone } from "@/lib/i18n/standalone"
import { RichMessage } from "@/lib/i18n/RichMessage"
import type { MessageKey } from "@/lib/i18n/messages/en"
import {
  importFile,
  importEBible,
  importObs,
  importHelloao,
  importMacula,
  importTranslationNotes,
  importBiblicaStudyNotes,
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
  type BiblicaProgress,
  type BiblicaEdition,
  type ParatextImportProgress,
  type SourceCellRef,
  type ImportResult,
} from "@/lib/import"
import type { PreparedImportFile } from "@/lib/import/import-service"
import { GoogleDrivePanel } from "@/components/import/GoogleDrivePanel"
import { importSdbh, type SdbhImportProgress } from "@/lib/import-sdbh"
import { assertSourceUploadByteLength } from "@/lib/sync/source-upload"
import { PreviewPanel, type ImportUploadProgress, type PreviewConfirmOptions } from "@/components/import/PreviewPanel"
import { formatBytesProgress } from "@/lib/format-bytes"
import type { FileReference, ProjectTtsSettings } from "@/lib/parsers/types"
import { detectFileType, isMediaFileType } from "@/lib/parsers/types"
import { filterEpubStrings } from "@/lib/parsers/epub"
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

type Screen = "landing" | "upload" | "preview" | "ebible" | "helloao" | "obs" | "macula" | "tn" | "biblica" | "direction" | "result" | "collision" | "spreadsheet" | "labels" | "paired" | "sdbh" | "dcs" | "gdrive"

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
  const t = useT()
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
    commit: (options?: PreviewConfirmOptions) => void | Promise<void>
    /** Surface to restore if the user cancels the preview. */
    returnScreen: "upload" | "spreadsheet" | "gdrive"
  } | null>(null)
  const [spreadsheetSeedFile, setSpreadsheetSeedFile] = useState<File | null>(null)
  const [spreadsheetReturnScreen, setSpreadsheetReturnScreen] = useState<"landing" | "upload" | "gdrive">("landing")
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
      setConfirmError(t("importExport.dialog.finishSaveFailed", { message }))
    } finally {
      flushingRef.current = false
      setConfirming(false)
    }
  }, [onImported, onOpenChange, projectId, t])

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
      setImportResultError(t("importExport.dialog.finishSaveFailed", { message }))
    }
  }, [importResult, handleChildImported, t])

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
      setConfirmError(t("importExport.dialog.saveFailed", { message }))
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
              t("nav.workspaceActions.import")
            ) : screen === "direction" ? (
              t("importExport.dialog.titleDirection")
            ) : screen === "result" ? (
              t("importExport.dialog.titleResult")
            ) : screen === "collision" ? (
              t("importExport.dialog.titleCollision")
            ) : screen === "preview" ? (
              <div className="flex items-center gap-2">
                <ImportDialogBackButton
                  onClick={() => {
                    const returnScreen = previewState?.returnScreen ?? "upload"
                    setPreviewState(null)
                    setPreviewCommitError(null)
                    setScreen(returnScreen)
                  }}
                  label={t("importExport.dialog.backToFileSelection")}
                />
                {t("importExport.dialog.titlePreview")}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <ImportDialogBackButton
                  onClick={() => setScreen("landing")}
                  label={t("importExport.dialog.backToImportTypes")}
                />
                {screen === "upload" ? t("importExport.landing.upload.title")
                  : screen === "gdrive" ? t("importExport.landing.gdrive.title")
                  : screen === "helloao" ? t("importExport.dialog.titleHelloao")
                  : screen === "obs" ? t("importExport.landing.obs.title")
                  : screen === "dcs" ? t("importExport.landing.dcs.title")
                  : screen === "macula" ? t("importExport.landing.macula.title")
                  : screen === "tn" ? t("importExport.dialog.titleTn")
                  : screen === "biblica" ? t("importExport.landing.biblica.title")
                  : screen === "spreadsheet" ? t("importExport.dialog.titleSpreadsheet")
                  : screen === "labels" ? t("importExport.landing.labels.title")
                  : screen === "paired" ? t("importExport.dialog.titlePaired")
                  : screen === "sdbh" ? t("importExport.landing.sdbh.title")
                  : t("importExport.landing.ebible.title")}
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

        {screen === "gdrive" && (
          <UploadPanel
            variant="gdrive"
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
              setPreviewState({ results, commit, returnScreen: "gdrive" })
              setScreen("preview")
            }}
            onSpreadsheetFile={(file) => {
              setSpreadsheetSeedFile(file)
              setSpreadsheetReturnScreen("gdrive")
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

        {screen === "biblica" && (
          <BiblicaPanel
            projectId={projectId}
            username={username}
            sourceLanguage={sourceLanguage}
            targetLanguage={targetLanguage}
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
            {t("importExport.dialog.labelsNeedSourceFile")}
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
            {t("importExport.dialog.pairedNeedsSourceCells")}
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
            onConfirm={async (options) => {
              setPreviewCommitError(null)
              await previewState.commit(options)
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

// AQU-832: title/hint/description are catalog keys, not English strings — this
// table is module-level, evaluated once before any I18nProvider exists, so it
// cannot call t() itself. OptionCard resolves each key at render time instead.
type ImportOption = {
  /** Screen to route to on select. Omitted for not-yet-available options. */
  id?: Screen
  titleKey: MessageKey
  /** Short qualifier shown in lighter weight after the title. */
  hintKey?: MessageKey
  descriptionKey: MessageKey
  icon: LucideIcon
  badge?: "beta" | "soon"
  disabled?: boolean
}

const POPULAR_OPTIONS: ImportOption[] = [
  { id: "upload", titleKey: "importExport.landing.upload.title", icon: Upload,
    descriptionKey: "importExport.landing.upload.description" },
  { id: "gdrive", titleKey: "importExport.landing.gdrive.title", hintKey: "importExport.landing.gdrive.hint", icon: CloudDownload, badge: "beta",
    descriptionKey: "importExport.googleDrive.description" },
  { id: "ebible", titleKey: "importExport.landing.ebible.title", hintKey: "importExport.landing.ebible.hint", icon: Library,
    descriptionKey: "importExport.landing.ebible.description" },
  { id: "helloao", titleKey: "importExport.landing.helloao.title", hintKey: "importExport.landing.helloao.hint", icon: Globe,
    descriptionKey: "importExport.landing.helloao.description" },
  { id: "spreadsheet", titleKey: "importExport.landing.spreadsheet.title", hintKey: "importExport.landing.spreadsheet.hint", icon: Table2, badge: "beta",
    descriptionKey: "importExport.landing.spreadsheet.description" },
]

const SPECIALIZED_OPTIONS: ImportOption[] = [
  { id: "macula", titleKey: "importExport.landing.macula.title", icon: Languages, badge: "beta",
    descriptionKey: "importExport.landing.macula.description" },
  { id: "paired", titleKey: "importExport.landing.paired.title", icon: ArrowLeftRight, badge: "beta",
    descriptionKey: "importExport.landing.paired.description" },
  { id: "labels", titleKey: "importExport.landing.labels.title", icon: Tags, badge: "beta",
    descriptionKey: "importExport.landing.labels.description" },
  { id: "tn", titleKey: "importExport.landing.tn.title", hintKey: "importExport.landing.tn.hint", icon: StickyNote, badge: "beta",
    descriptionKey: "importExport.landing.tn.description" },
  { id: "biblica", titleKey: "importExport.landing.biblica.title", hintKey: "importExport.landing.biblica.hint", icon: BookOpen, badge: "beta",
    descriptionKey: "importExport.landing.biblica.description" },
  { id: "obs", titleKey: "importExport.landing.obs.title", hintKey: "importExport.landing.obs.hint", icon: BookImage, badge: "beta",
    descriptionKey: "importExport.landing.obs.description" },
  { id: "dcs", titleKey: "importExport.landing.dcs.title", hintKey: "importExport.landing.dcs.hint", icon: Cloud, badge: "beta",
    descriptionKey: "importExport.landing.dcs.description" },
  { id: "sdbh", titleKey: "importExport.landing.sdbh.title", hintKey: "importExport.landing.sdbh.hint", icon: BookA, badge: "beta",
    descriptionKey: "importExport.landing.sdbh.description" },
  { id: "upload", titleKey: "importExport.landing.tm.title", hintKey: "importExport.landing.tm.hint", icon: Database,
    descriptionKey: "importExport.landing.tm.description" },
]

function OptionBadge({ kind }: { kind: "beta" | "soon" }) {
  const t = useT()
  if (kind === "soon") {
    return <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">{t("importExport.landing.badgeSoon")}</Badge>
  }
  return (
    <Badge
      variant="secondary"
      className="border border-amber-200 bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-400"
    >
      {t("importExport.landing.badgeBeta")}
    </Badge>
  )
}

function OptionCard({ option, onSelect }: { option: ImportOption; onSelect: (s: Screen) => void }) {
  const t = useT()
  const { icon: Icon, disabled } = option
  const title = t(option.titleKey)
  const select = () => { if (!disabled && option.id) onSelect(option.id) }
  const disabledTooltip = disabled
    ? t("importExport.landing.comingSoonTooltip", { title })
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
          : "transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium leading-none">{title}</span>
            {option.hintKey && <span className="text-xs text-muted-foreground">{t(option.hintKey)}</span>}
            {option.badge && <span className="ml-auto shrink-0"><OptionBadge kind={option.badge} /></span>}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t(option.descriptionKey)}</p>
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
      <h3 className="px-0.5 text-xs font-medium text-muted-foreground/70">{label}</h3>
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
  const t = useT()
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
        [t(o.titleKey), o.hintKey ? t(o.hintKey) : "", t(o.descriptionKey)].some((s) => s.toLowerCase().includes(q)),
      )
    : available
  return (
    <div className="space-y-5 py-1">
      <p className="text-sm text-muted-foreground">{t("importExport.landing.intro")}</p>
      <ImportSection label={t("importExport.landing.popularSection")}>
        {POPULAR_OPTIONS.map((o) => (
          <OptionCard key={o.titleKey} option={o} onSelect={onSelect} />
        ))}
      </ImportSection>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="px-0.5 text-xs font-medium text-muted-foreground/70">{t("importExport.landing.specializedSection")}</h3>
          <InputGroup className="h-7 w-44">
            <InputGroupAddon>
              <Search className="text-muted-foreground/60" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("importExport.landing.filterPlaceholder")}
              aria-label={t("importExport.landing.filterAriaLabel")}
              className="text-xs placeholder:text-muted-foreground/60"
            />
          </InputGroup>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {specialized.map((o) => (
            <OptionCard key={o.titleKey} option={o} onSelect={onSelect} />
          ))}
          {specialized.length === 0 && (
            <p className="col-span-full px-0.5 py-2 text-xs text-muted-foreground">
              {t("importExport.landing.noMatches", { filter })}
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
  onPreview?: (results: ImportResult[], commit: (options?: PreviewConfirmOptions) => Promise<void>) => void
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
  /** AQU-823: "gdrive" swaps the dropzone for the Google Drive picker while
   *  reusing this panel's preview/collision/commit machinery unchanged. */
  variant?: "upload" | "gdrive"
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
  const actionKey = progress.phase === "inspect"
    ? "importExport.upload.idmlChecking"
    : progress.phase === "unpack"
      ? "importExport.upload.idmlOpening"
      : "importExport.upload.idmlReading"
  const count = progress.total > 1
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

function UploadPanel({ projectId, username, sourceLanguage, targetLanguage, targetLang, identityToken, getToken, onImported, ttsSettings, onCastUpdated, existingFiles, onCollision, onPreview, onCommitPhase, onCommitProgress, onCommitError, onSpreadsheetFile, excludeFrontMatter, variant = "upload" }: UploadPanelProps) {
  const t = useT()
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string>("")
  const [progress, setProgress] = useState<ImportUploadProgress | null>(null)
  const parseAbortRef = useRef<AbortController | null>(null)
  // AQU-823: per-file Drive provenance (normalized name → origin), set by the
  // gdrive variant just before handleFiles and stamped into importManifest.
  const originsRef = useRef<Map<string, Record<string, unknown>> | null>(null)
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
        onPreview(allParsedResults, async (options) => {
          if (options?.skipMemberPaths && options.skipMemberPaths.size > 0) {
            for (const [file, prepared] of preparedByFile) {
              preparedByFile.set(file, {
                ...prepared,
                results: prepared.results.map((result) => ({
                  ...result,
                  strings: result.epubMembers
                    ? filterEpubStrings(result.strings, options.skipMemberPaths!)
                    : result.strings,
                })),
              })
            }
          }
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
                  count: progress.count.toLocaleString(),
                  total: progress.total.toLocaleString(),
                })}
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
            <p className="mt-2 text-xs text-muted-foreground">{t("importExport.action.working")}</p>
          )}
        </div>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            {t("importExport.upload.dragDropHint")}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" nativeButton={false} render={<label />}>
              {t("importExport.upload.chooseFiles")}
              <input
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInput}
              />
            </Button>
            <Button variant="outline" nativeButton={false} render={<label />}>
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
  const t = useT()
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
        setError(err instanceof Error ? err.message : t("importExport.paratext.couldNotReadProject"))
      })
    return () => { cancelled = true }
  }, [entries, projectId, excludeFrontMatter, t])

  function onProgress(p: ParatextImportProgress) {
    const bookLabel = p.book
      ? t("importExport.paratext.bookProgressLabel", {
          book: p.book,
          done: Math.min(p.booksDone + 1, p.booksTotal),
          total: p.booksTotal,
        })
      : t("importExport.paratext.booksProgressLabel", { done: p.booksDone, total: p.booksTotal })
    setPhase(p.book ? t("importExport.paratext.uploadingBook", { book: p.book }) : t("common.uploading"))
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
    setMode("importing"); setError(null); setPhase(t("common.uploading")); setProgress(null)
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
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed")); setMode("choose")
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
        setError(err instanceof Error ? err.message : t("importExport.paratext.couldNotLoadSourceList"))
      }
    }
  }

  async function runTargetWithResolution(sel: EBibleTranslation, resolution: CollisionResolution) {
    if (!plan) return
    setMode("importing"); setError(null); setPhase(t("importExport.paratext.fetchingSource", { title: sel.title })); setProgress(null)
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
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed")); setMode("pickSource")
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
          (tr) =>
            tr.id.toLowerCase().includes(q) ||
            tr.title.toLowerCase().includes(q) ||
            tr.languageNameInEnglish.toLowerCase().includes(q),
        )
      : translations
    return base.slice(0, 200)
  }, [translations, query])

  if (mode === "importing") {
    return (
      <div className="mx-auto w-full max-w-sm py-8 text-center">
        <p className="text-sm font-medium">{phase || t("importExport.action.importing")}</p>
        {progress && progress.total > 0 && (
          <>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((progress.count / progress.total) * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("importExport.paratext.cellsProgress", {
                count: progress.count.toLocaleString(),
                total: progress.total.toLocaleString(),
                bookLabel: progress.bookLabel,
              })}
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
          <p className="text-sm font-medium">{t("importExport.paratext.pickSourceTitle")}</p>
          <Button variant="ghost" onClick={() => setMode("choose")}>{t("common.back")}</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("importExport.paratext.pickSourceHint")}
        </p>
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            placeholder={t("importExport.paratext.searchTranslationsPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("importExport.paratext.searchTranslationsAriaLabel")}
          />
        </InputGroup>
        <ScrollArea className="h-64 rounded border">
          {!translations ? (
            <p className="p-3 text-sm text-muted-foreground">{t("importExport.paratext.loadingSourceList")}</p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t("common.noMatches")}</p>
          ) : (
            <ul className="divide-y">
              {filtered.map((tr) => (
                <li key={tr.id}>
                  <button type="button" onClick={() => runTarget(tr)} className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-accent">
                    <span className="text-sm">{tr.title}</span>
                    <span className="text-xs text-muted-foreground">{tr.languageNameInEnglish} · {tr.id}</span>
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
          {t("importExport.paratext.projectDetected", { count: plan ? plan.books.length : bookCount })}
        </p>
        <p className="text-xs text-muted-foreground">
          {plan
            ? (
              <>
                {language && <>{t("importExport.paratext.languageLabel", { language })} · </>}
                {t("importExport.paratext.cellsParsedHint", { count: includedCells.toLocaleString() })}
              </>
            )
            : t("importExport.paratext.readingProject")}
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
                      aria-label={t("importExport.paratext.includeBookAriaLabel", { book: b.book.displayName })}
                    />
                    <button
                      type="button"
                      onClick={() => setExpandedBook(expanded ? null : key)}
                      className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                      aria-label={t("importExport.paratext.showParsedCellsAriaLabel")}
                    >
                      <span className={`truncate text-sm ${included ? "" : "text-muted-foreground line-through"}`}>{b.book.displayName}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t("importExport.paratext.bookCellsCount", { bookId: b.book.bookId, count: b.cellCount.toLocaleString() })}
                        {b.duplicateRefs.length > 0 && (
                          <span className="text-amber-600">
                            {" · "}
                            {t("importExport.paratext.duplicateRefsCount", { count: b.duplicateRefs.length })}
                          </span>
                        )}
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
                        <li className="text-xs text-muted-foreground/70">
                          {t("importExport.paratext.moreCells", { count: (b.strings.length - 4).toLocaleString() })}
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("importExport.paratext.howToBringIn")}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button type="button" onClick={runSource} disabled={!plan || includedBooks.length === 0} className="rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50">
          <p className="text-sm font-medium">{t("importExport.paratext.sourceTextTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("importExport.paratext.sourceTextDescription")}</p>
        </button>
        <button type="button" onClick={startTarget} disabled={!plan || includedBooks.length === 0} className="rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50">
          <p className="text-sm font-medium">{t("importExport.paratext.translationInProgressTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("importExport.paratext.translationInProgressDescription")}</p>
        </button>
      </div>
      <div>
        <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
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
                enqueued: (targetProgress.cellsEnqueued ?? 0).toLocaleString(),
                total: targetProgress.cellsTotal.toLocaleString(),
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
        <Button onClick={() => onTargetImported?.()}>{t("common.close")}</Button>
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
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
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
                  progress: formatProgress(progress.received, progress.total),
                })
              : progress.phase === "parse"
                ? t("importExport.helloao.parsingVerses")
                : progress.cellsTotal
                  ? t("importExport.helloao.uploadingVerses", {
                      enqueued: (progress.cellsEnqueued ?? 0).toLocaleString(),
                      total: progress.cellsTotal.toLocaleString(),
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
                  progress: formatProgress(targetProgress.received, targetProgress.total),
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
            {importing ? t("importExport.action.importing") : t("nav.workspaceActions.import")}
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
  const t = useT()
  const [translations, setTranslations] = useState<HelloaoTranslation[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<HelloaoTranslation | null>(null)

  // Book-selection step: loaded when a translation is chosen.
  const [books, setBooks] = useState<HelloaoBook[] | null>(null)
  const [booksErr, setBooksErr] = useState<string | null>(null)
  const [checkedBooks, setCheckedBooks] = useState<Set<string>>(new Set())
  const [bookPreset, setBookPreset] = useState<"all" | "OT" | "NT">("all")

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
        (tr) =>
          tr.id.toLowerCase().includes(q) ||
          tr.name.toLowerCase().includes(q) ||
          tr.englishName.toLowerCase().includes(q) ||
          tr.languageEnglishName.toLowerCase().includes(q) ||
          tr.languageName.toLowerCase().includes(q)
      )
      .slice(0, 200)
  }, [translations, query])

  function handleSelect(tr: HelloaoTranslation) {
    setSelected(tr)
    setBooks(null)
    setBooksErr(null)
    setCheckedBooks(new Set())
    setBookPreset("all")
    fetchHelloaoBooks(tr.id)
      .then((list) => {
        setBooks(list)
        // Default: everything selected (whole bible).
        setCheckedBooks(new Set(list.map((b) => b.id)))
        setBookPreset("all")
      })
      .catch((err) => {
        setBooksErr(err instanceof Error ? err.message : String(err))
      })
  }

  function applyPreset(preset: "all" | "OT" | "NT") {
    if (!books) return
    setBookPreset(preset)
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
      setImportErr(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
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
            label={t("importExport.helloao.backToList")}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{selected.englishName || selected.name}</p>
            <p className="text-xs text-muted-foreground">
              {selected.languageEnglishName || selected.languageName} ·{" "}
              <a href={selected.licenseUrl} target="_blank" rel="noreferrer" className="underline">
                {t("importExport.helloao.license")}
              </a>
            </p>
          </div>
        </div>

        {booksErr ? (
          <p className="text-sm text-destructive">{t("importExport.helloao.failedToLoadBooks", { error: booksErr })}</p>
        ) : !books ? (
          <p className="text-sm text-muted-foreground">{t("importExport.helloao.loadingBooks")}</p>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <SegmentTabs
                aria-label={t("importExport.helloao.presetAriaLabel")}
                value={bookPreset}
                onValueChange={(preset) => {
                  if (!importing) applyPreset(preset)
                }}
                options={[
                  { value: "all", label: t("importExport.helloao.presetWholeBible"), disabled: importing },
                  { value: "OT", label: t("importExport.helloao.presetOldTestament"), disabled: importing },
                  { value: "NT", label: t("importExport.helloao.presetNewTestament"), disabled: importing },
                ]}
              />
              <span className="ml-auto text-xs text-muted-foreground">
                {t("importExport.helloao.booksSelected", { checked: checkedBooks.size, total: books.length })}
              </span>
            </div>

            <ScrollArea className="h-64 rounded-md border">
              <ul className="grid grid-cols-2 gap-x-2 p-2 sm:grid-cols-3">
                {books.map((b) => (
                  <li key={b.id}>
                    <label className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
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
                ? t("importExport.ebible.downloading", {
                    id: selected.id,
                    progress: formatProgress(progress.received, progress.total),
                  })
                : progress.phase === "parse"
                  ? t("importExport.helloao.parsingVerses")
                  : progress.cellsTotal
                    ? t("importExport.helloao.uploadingVerses", {
                        enqueued: (progress.cellsEnqueued ?? 0).toLocaleString(),
                        total: progress.cellsTotal.toLocaleString(),
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

        {importErr && <p className="text-sm text-destructive">{importErr}</p>}

        <div className="flex items-center justify-end gap-3">
          {books && checkedBooks.size > 0 && (
            <span className="text-xs text-muted-foreground">
              {t("importExport.helloao.approxVerseCount", { count: selectedVerseCount.toLocaleString() })}
            </span>
          )}
          <Button onClick={handleImport} disabled={!books || checkedBooks.size === 0 || importing}>
            {importing ? t("importExport.action.importing") : t("nav.workspaceActions.import")}
          </Button>
        </div>
      </div>
    )
  }

  // ── Translation picker step ─────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        <RichMessage
          k="importExport.helloao.description"
          values={{
            link: (
              <a href="https://bible.helloao.org/docs/" target="_blank" rel="noreferrer" className="underline">
                {t("importExport.helloao.apiLinkText")}
              </a>
            ),
          }}
        />
      </p>

      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder={t("importExport.helloao.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!translations}
          aria-label={t("importExport.helloao.searchAriaLabel")}
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
            {filtered.map((tr) => (
              <li key={tr.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(tr)}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="font-medium">{tr.englishName || tr.name}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {tr.id}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t("importExport.helloao.languageAndBookCount", {
                      language: tr.languageEnglishName || tr.languageName,
                      count: tr.numberOfBooks,
                    })}
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
  const t = useT()
  // WARN e: use normalizer so "French"=="fra" registers as same and blocks confirm.
  const targetTrimmed = targetLanguage.trim()
  const sourceTrimmed = sourceLanguage.trim()
  const confirmDisabled =
    confirming ||
    !targetTrimmed ||
    languagesEqual(targetTrimmed, sourceTrimmed)

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">{t("importExport.direction.intro")}</p>
      <FieldGroup className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel htmlFor="dl-source">{t("projectSettings.info.sourceLanguageLabel")}</FieldLabel>
          <Input
            id="dl-source"
            value={sourceLanguage}
            onChange={(e) => onSourceChange(e.target.value)}
            placeholder={t("importExport.direction.sourcePlaceholder")}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="dl-target">
            {t("importExport.direction.targetLabel")} <span className="text-destructive">*</span>
          </FieldLabel>
          <Input
            id="dl-target"
            value={targetLanguage}
            onChange={(e) => onTargetChange(e.target.value)}
            placeholder={t("importExport.direction.targetPlaceholder")}
            autoFocus
          />
        </Field>
      </FieldGroup>
      <p className="text-xs text-muted-foreground">
        <RichMessage
          k="importExport.direction.changeLaterHint"
          values={{ path: <strong>{t("importExport.direction.settingsBreadcrumb")}</strong> }}
        />
      </p>
      {/* AQU-249: restore direction screen on failure so the user can retry */}
      {error && <FieldError role="alert">{error}</FieldError>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onSkip} disabled={confirming}>
          {t("onboarding.common.skipForNow")}
        </Button>
        <Button
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          {confirming ? t("importExport.direction.setting") : t("importExport.direction.setDirection")}
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
  const t = useT()
  const [copied, setCopied] = useState(false)
  const [dismissing, setDismissing] = useState(false)

  // Two independent counts (imported vs. skipped) can't share one plural
  // template — English "1 item imported, 2 skipped" hides that "item" and
  // "skipped" each agree with a different number, which breaks for a locale
  // with real plural agreement. Resolved as two separately-pluralized
  // sub-phrases and interpolated into the header, so each stays grammatical.
  const importedPhrase = t("importExport.result.reportImportedCount", { count: importedCount })
  const skippedPhrase = t("importExport.result.reportSkippedCount", { count: skipped.length })
  const reportText = [
    t("importExport.result.reportHeader", { imported: importedPhrase, skipped: skippedPhrase }),
    "",
    t("importExport.result.reportSkippedListLabel"),
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
        <RichMessage
          k="importExport.result.summaryImported"
          count={importedCount}
          values={{ count: <span className="font-medium text-foreground">{importedCount}</span> }}
        />{" "}
        <RichMessage
          k="importExport.result.summarySkipped"
          values={{ count: <span className="font-medium text-amber-600">{skipped.length}</span> }}
        />{" "}
        {t("importExport.result.summaryReviewHint")}
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
        <Button variant="outline" onClick={handleCopy} disabled={dismissing}>
          {copied ? t("nav.report.copied") : t("nav.report.copyReport")}
        </Button>
        <Button onClick={handleDismiss} disabled={dismissing}>
          {dismissing ? t("importExport.result.closing") : t("common.close")}
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
  const t = useT()
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
        {t("importExport.collision.intro", { count: collisions.length })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("importExport.collision.updateHint")}
      </p>
      {collisions.some((collision) => collision.ambiguous) && (
        <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
          {t("importExport.collision.ambiguousWarning")}
        </p>
      )}

      {/* Apply-to-all row */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t("importExport.collision.applyToAll")}</span>
        <button
          type="button"
          onClick={() => setAll("update")}
          disabled={!canUpdateAll}
          className={cn(
            "rounded border px-2 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            allUpdate ? "border-primary bg-primary/10 text-primary" : "border-muted text-muted-foreground hover:border-foreground/40",
          )}
        >
          {t("importExport.collision.updateAll")}
        </button>
        <button
          type="button"
          onClick={() => setAll("skip")}
          className={cn(
            "rounded border px-2 py-0.5 transition-colors",
            allSkip ? "border-primary bg-primary/10 text-primary" : "border-muted text-muted-foreground hover:border-foreground/40",
          )}
        >
          {t("importExport.collision.skipAll")}
        </button>
        <button
          type="button"
          onClick={() => setAll("duplicate")}
          className={cn(
            "rounded border px-2 py-0.5 transition-colors",
            allDup ? "border-primary bg-primary/10 text-primary" : "border-muted text-muted-foreground hover:border-foreground/40",
          )}
        >
          {t("importExport.collision.duplicateAll")}
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
                    {t("importExport.collision.existing", { name: c.existingName })}
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
                    {t("importExport.collision.updateExisting")}
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
                    {t("importExport.collision.skip")}
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
                    {t("importExport.collision.duplicate")}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={resolving}>
          {t("common.cancel")}
        </Button>
        <Button onClick={handleConfirm} disabled={resolving}>
          {resolving ? t("importExport.collision.continuing") : t("onboarding.common.continue")}
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
  const t = useT()
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
      setImportErr(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
    } finally {
      setImporting(false)
      abortRef.current = null
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        <RichMessage
          k="importExport.obs.description"
          values={{
            link: (
              <a href="https://git.door43.org/unfoldingWord/en_obs" target="_blank" rel="noreferrer" className="underline">
                {/* i18n-exempt organisation/repository name */}
                unfoldingWord/door43
              </a>
            ),
          }}
        />
      </p>

      {progress && (
        <div className="text-xs text-muted-foreground">
          <p>
            {progress.phase === "download"
              ? t("importExport.obs.downloading", {
                  progress: formatProgress(progress.received, progress.total),
                })
              : progress.phase === "parse"
                ? t("importExport.obs.parsingFrames")
                : progress.cellsTotal
                  ? t("importExport.obs.uploadingFrames", {
                      enqueued: (progress.cellsEnqueued ?? 0).toLocaleString(),
                      total: progress.cellsTotal.toLocaleString(),
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

      {importErr && <p className="text-sm text-destructive">{importErr}</p>}

      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={importing}>
          {importing ? t("importExport.action.importing") : t("importExport.obs.downloadAndImport")}
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
  const t = useT()
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
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
      setStage("browse")
    } finally {
      abortRef.current = null
    }
  }, [projectId, getToken, patchDcsCursor, onImported, excludeFrontMatter, t])

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
          {t("importExport.dcs.importingResource", {
            resource: selected?.fullName ?? t("importExport.dcs.genericResource"),
            ref: selected?.ref ? ` @ ${selected.ref}` : "",
          })}
        </p>
        {progress && progress.total > 0 ? (
          <>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("importExport.dcs.filesProgress", {
                uploaded: progress.uploaded.toLocaleString(),
                total: progress.total.toLocaleString(),
              })}
            </p>
          </>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">{t("importExport.dcs.fetchingAndParsing")}</p>
        )}
      </div>
    )
  }

  // stage === "done"
  return (
    <div className="mx-auto w-full max-w-sm py-8 text-center">
      <p className="text-sm font-medium">{t("importExport.dcs.importComplete")}</p>
      {summary && (
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p>{selected?.fullName}</p>
          <p>
            {/* Two independent counts (files, cells) — each pluralized on its own and
             *  joined, rather than one template agreeing with two numbers at once. */}
            {t("search.expanded.fileCount", { count: summary.files })}
            {" · "}
            {t("common.cellCount", { count: summary.cells })}
          </p>
          <p>
            {summary.pinned
              ? (
                <RichMessage
                  k="importExport.dcs.pinnedToRelease"
                  values={{ ref: <span className="font-medium text-foreground/80">{summary.ref}</span> }}
                />
              )
              : <span className="text-amber-600 dark:text-amber-400">{t("importExport.dcs.couldNotPin")}</span>}
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
  const t = useT()
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
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
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
            // i18n-exempt example filename
            masterFile: <code>SDBH-en.JSON</code>,
            // i18n-exempt example filename
            localizedFile: <code>SDBH-es.JSON</code>,
          }}
        />
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" nativeButton={false} render={<label />}>
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
        <Button variant="outline" nativeButton={false} render={<label />}>
          {localizedFile ? localizedFile.name : <>{t("importExport.sdbh.chooseLocalized")} <OptionalMark /></>}
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
                      enqueued: (progress.cellsEnqueued ?? 0).toLocaleString(),
                      total: progress.cellsTotal.toLocaleString(),
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
  const t = useT()
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
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-xs text-muted-foreground">
        <RichMessage
          k="importExport.macula.description"
          values={{
            link: (
              <a
                href="https://github.com/Clear-Bible/macula-hebrew"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {t("importExport.macula.linkText")}
              </a>
            ),
          }}
        />
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" nativeButton={false} render={<label />}>
          {file ? file.name : t("importExport.macula.chooseFile")}
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
          {progress.phase === "parse" && t("importExport.macula.parsing")}
          {progress.phase === "save" && progress.cellsTotal && (
            <>
              <p>
                {t("importExport.macula.uploadingCells", {
                  enqueued: (progress.cellsEnqueued ?? 0).toLocaleString(),
                  total: progress.cellsTotal.toLocaleString(),
                })}
              </p>
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
          {importing ? t("importExport.action.importing") : t("nav.workspaceActions.import")}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Biblica Study Bible Notes (IDML) panel
// ---------------------------------------------------------------------------

interface BiblicaPanelProps {
  projectId: string
  username: string
  sourceLanguage?: string
  targetLanguage?: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference) => void | Promise<void>
}

function BiblicaPanel({
  projectId,
  username,
  sourceLanguage,
  targetLanguage,
  getToken,
  onImported,
}: BiblicaPanelProps) {
  const t = useT()
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<BiblicaProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  // Off by default: each InDesign line stays one cell unless the translator opts in.
  const [splitSentences, setSplitSentences] = useState(false)
  // The three Biblica templates disagree about what a paragraph style means —
  // a study Bible marks its notes, the other two mark scripture instead — and
  // nothing in the package says which title it is, so the person importing it
  // does. One edition at a time, hence a single value rather than two flags.
  const [edition, setEdition] = useState<BiblicaEdition>("study-notes")

  async function handleImport() {
    if (!file || importing) return
    setImporting(true)
    setError(null)
    setProgress({ phase: "parse" })
    try {
      const ref = await importBiblicaStudyNotes(
        file,
        {
          projectId,
          author: username,
          ...(sourceLanguage ? { sourceLanguage } : {}),
          ...(targetLanguage ? { targetLanguage } : {}),
          getToken,
        },
        setProgress,
        { splitSentences, edition },
      )
      await onImported(ref)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  function chooseEdition(next: BiblicaEdition, checked: boolean) {
    setEdition(checked ? next : "study-notes")
    setError(null)
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-xs text-muted-foreground">
        {edition === "treasure-hunt"
          ? t("importExport.biblica.descriptionTreasureHunt")
          : edition === "reach4life"
          ? t("importExport.biblica.descriptionReach4Life")
          : t("importExport.biblica.description")}
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer" />}>
          {file
            ? file.name
            : edition === "treasure-hunt" ? t("importExport.biblica.chooseFileTreasureHunt")
            : edition === "reach4life" ? t("importExport.biblica.chooseFileReach4Life")
            : t("importExport.biblica.chooseFile")}
          <input
            type="file"
            className="hidden"
            accept=".idml"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              setFile(f)
              setError(null)
            }}
            disabled={importing}
          />
        </Button>
        {file && !importing && (
          <p className="text-xs text-muted-foreground">
            {file.name} — {(file.size / 1024 / 1024).toFixed(2)} MB
          </p>
        )}
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={edition === "treasure-hunt"}
            disabled={importing}
            onCheckedChange={(checked) => chooseEdition("treasure-hunt", checked === true)}
            aria-label={t("importExport.biblica.treasureHuntLabel")}
          />
          <span className="flex flex-col gap-0.5">
            <span>{t("importExport.biblica.treasureHuntLabel")}</span>
            <span className="text-xs text-muted-foreground">
              {t("importExport.biblica.treasureHuntHint")}
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={edition === "reach4life"}
            disabled={importing}
            onCheckedChange={(checked) => chooseEdition("reach4life", checked === true)}
            aria-label={t("importExport.biblica.reach4lifeLabel")}
          />
          <span className="flex flex-col gap-0.5">
            <span>{t("importExport.biblica.reach4lifeLabel")}</span>
            <span className="text-xs text-muted-foreground">
              {t("importExport.biblica.reach4lifeHint")}
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={splitSentences}
            disabled={importing}
            onCheckedChange={(checked) => setSplitSentences(checked === true)}
            aria-label={t("importExport.biblica.splitSentencesLabel")}
          />
          <span className="flex flex-col gap-0.5">
            <span>{t("importExport.biblica.splitSentencesLabel")}</span>
            <span className="text-xs text-muted-foreground">
              {t("importExport.biblica.splitSentencesHint")}
            </span>
          </span>
        </label>
      </div>
      {progress && (
        <div className="text-xs text-muted-foreground">
          {progress.phase === "parse" && (
            <p>
              {progress.idml?.total
                ? t("importExport.biblica.readingPackageWithProgress", {
                    completed: progress.idml.completed,
                    total: progress.idml.total,
                  })
                : t("importExport.biblica.readingPackage")}
            </p>
          )}
          {progress.phase === "save" && progress.cellsTotal && (
            <>
              <p>
                {t("importExport.tn.uploadingNotes", {
                  enqueued: (progress.cellsEnqueued ?? 0).toLocaleString(),
                  total: progress.cellsTotal.toLocaleString(),
                })}
              </p>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round(((progress.cellsEnqueued ?? 0) / progress.cellsTotal) * 100)}%` }}
                />
              </div>
              {progress.verseUnitCount ? (
                <p className="mt-1.5">
                  {t("importExport.biblica.paragraphsSkipped", { count: progress.verseUnitCount })}
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={!file || importing}>
          {importing ? t("importExport.action.importing") : t("nav.workspaceActions.import")}
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
  const t = useT()
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
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-xs text-muted-foreground">
        <RichMessage
          k="importExport.tn.description"
          values={{
            link: (
              <a
                href="https://door43.org/u/Door43-Catalog/en_tn/"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {t("importExport.tn.linkText")}
              </a>
            ),
          }}
        />
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" nativeButton={false} render={<label />}>
          {file ? file.name : t("importExport.tn.chooseFile")}
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
          {progress.phase === "parse" && t("importExport.tn.parsing")}
          {progress.phase === "save" && progress.cellsTotal && (
            <>
              <p>
                {t("importExport.tn.uploadingNotes", {
                  enqueued: (progress.cellsEnqueued ?? 0).toLocaleString(),
                  total: progress.cellsTotal.toLocaleString(),
                })}
              </p>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round(((progress.cellsEnqueued ?? 0) / progress.cellsTotal) * 100)}%` }}
                />
              </div>
              {progress.skippedCount ? (
                <p className="mt-1 text-yellow-600">
                  {t("importExport.tn.rowsSkipped", { count: progress.skippedCount })}
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={!file || importing}>
          {importing ? t("importExport.action.importing") : t("nav.workspaceActions.import")}
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
