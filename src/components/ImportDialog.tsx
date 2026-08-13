import { useCallback, useEffect, useRef, useState } from "react"
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { type SourceCellRef, type ImportResult } from "@/lib/import"
import { PreviewPanel, type ImportUploadProgress } from "@/components/import/PreviewPanel"
import type { FileReference, ProjectTtsSettings } from "@/lib/parsers/types"
import { languagesEqual } from "@/lib/language-normalize"
import { type CollisionResult } from "@/lib/import-collision"
import posthog from "@/lib/posthog"
import { IMPORT_STARTED, IMPORT_SUCCEEDED, IMPORT_PARTIAL, IMPORT_COLLISION_DETECTED, IMPORT_COLLISION_SKIPPED, IMPORT_COLLISION_DUPLICATED } from "@/lib/event-names"
import { SpreadsheetImportPanel } from "@/components/import/SpreadsheetImportPanel"
import { LabelImportPanel, type LabelImportResult } from "@/components/import/LabelImportPanel"
import { PairedImportPanel } from "@/components/import/PairedImportPanel"
import type { DcsCursor } from "@/lib/dcs/types"
import { useT } from "@/lib/i18n/I18nProvider"

import type { Screen, CollisionResolution } from "@/components/import/import-dialog-types"
import { ImportDialogBackButton } from "@/components/import/ImportDialogBackButton"
import { ImportLanding } from "@/components/import/ImportLanding"
import { UploadPanel } from "@/components/import/UploadPanel"
import { EBiblePanel } from "@/components/import/EBiblePanel"
import { HelloaoPanel } from "@/components/import/HelloaoPanel"
import { ObsPanel } from "@/components/import/ObsPanel"
import { DcsPanel } from "@/components/import/DcsPanel"
import { MaculaPanel } from "@/components/import/MaculaPanel"
import { TnPanel } from "@/components/import/TnPanel"
import { BiblicaPanel } from "@/components/import/BiblicaPanel"
import { SdbhPanel } from "@/components/import/SdbhPanel"
import { DirectionPanel } from "@/components/import/DirectionPanel"
import { ImportResultPanel } from "@/components/import/ImportResultPanel"
import { CollisionPanel } from "@/components/import/CollisionPanel"

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
    commit: () => void | Promise<void>
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
                {t("common.preview")}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <ImportDialogBackButton
                  onClick={() => setScreen("landing")}
                  label={t("importExport.dialog.backToImportTypes")}
                />
                {screen === "upload" ? t("importExport.landing.upload.title")
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
