import { Suspense, lazy, useState, useMemo, useRef, useEffect, useCallback } from "react"
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom"
import { useProject } from "@/hooks/useProject"
import { useNavHistoryTitle } from "@/context/NavHistoryContext"
import { deriveNavTitle } from "@/lib/navigation/deriveTitle"
import { deriveCellAreaState } from "@/lib/editor/cell-area-state"
import { CellAreaPlaceholder } from "./CellAreaPlaceholder"
import { WorkspaceSkeleton } from "./WorkspaceSkeleton"
import { TabStrip } from "./TabStrip"
import { useWorkspaceTabs, readLastActiveFileId } from "@/hooks/useWorkspaceTabs"
import { clearLastLocation, readLastLocation, writeLastLocation } from "@/lib/frontier/last-location-store"
import { ROLE } from "@/lib/frontier/roles"
import { languagesEqual } from "@/lib/language-normalize"
import { readAtVersion, useActiveCellStore, useCellStoreVersion, type CellStore, type CellSummary } from "@/hooks/useActiveCellStore"
import { useStaleSourceCells } from "@/hooks/useStaleSourceCells"
import { triggerLinkSync } from "@/lib/sync/archive"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { useCompletion, FALLBACK_COMPLETION_SETTINGS } from "@/hooks/useCompletion"
import { DEFAULT_DRAFT_CONTEXT } from "@/lib/completion/draft-context"
import { fetchBranchingSearch } from "@/lib/sync/branching-search-read"
import { fetchBranchingSearchPassages } from "@/lib/sync/branching-search-passages-read"
import type { ScoredPair } from "@/lib/search/dual-index"
import type { PassageHit } from "@/hooks/useSearchIndex"
import { useHealth } from "@/hooks/useHealth"
import { useCellConfidence } from "@/hooks/useCellConfidence"
import { useRules } from "@/hooks/useRules"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { useActiveOrg } from "@/context/OrgContext"
import { updateProject, patchProject, getProject, mergeServerProjectWithLocalCache } from "@/lib/store/project-index"
import { completionBatchSizeFor } from "@/lib/workspace-actions/registry"
import type { FileReference } from "@/lib/parsers/types"
import { fileOrderedBy, fileTypeHasSections, isMediaFileType, projectHasScriptureFiles, resolveBibleResourcesEnabled } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { resolveDeepLinkLane } from "./project-workspace-lane-deeplink"
import { resolveActiveTargetLanguage } from "./project-workspace-lane-target"
import { useWorkspaceSearch } from "@/hooks/useWorkspaceSearch"
import { ParallelPassagesPanel, type ParallelPanelMode, type ParallelPanelScope, type ReplaceAllPayload } from "./ParallelPassagesPanel"
import type { EditorTableHandle } from "./EditorTable"
import type { WorkspaceSearchResult } from "@/hooks/useWorkspaceSearch"
import { StatusBar } from "./StatusBar"
import { SyncStatusIndicator } from "./SyncStatusIndicator"
import { OutboxSyncIndicator } from "./OutboxSyncIndicator"
import { EditorTable, type AudioLensContext, type BacktranslationActionSource } from "./EditorTable"
import { FootnotesTray } from "./footnotes/FootnoteInline"
import { AudioRecordingModal } from "./AudioRecorder/AudioRecordingModal"
import { VoiceSidebar } from "./voice/VoiceSidebar"
import { VoicePlaybackBar } from "./voice/VoicePlaybackBar"
import { startQueue } from "@/lib/audio/play-queue"
import { generateCombinedVoice, type CombinedVoiceResult } from "@/lib/audio/combined-voice"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { CombinedBoundaryEditor } from "./voice/CombinedBoundaryEditor"
import { useProjectTts } from "@/hooks/useProjectTts"
import { RuleDrawer } from "./RuleDrawer"
import { RulesSurface } from "./RulesSurface"
import { RuleImportDialog } from "./RuleImportDialog"
import { RuleSuggestFromEditsDialog } from "./RuleSuggestFromEditsDialog"
import { CommentsDrawer } from "./CommentsDrawer"
import { HistoryDrawer } from "./HistoryDrawer"
import { SharePanel } from "./SharePanel"
import { VideoPlayer, type VideoPlayerHandle } from "./VideoPlayer"
import { ResizableVideoPanel } from "./ResizableVideoPanel"
import { VideoAttachmentDialog } from "./VideoAttachmentDialog"
import { parseTimestampRange, extractCuesFromCells } from "@/lib/video/vtt-generator"
import { useFileSync } from "@/hooks/useFileSync"
import { useFileMeta } from "@/hooks/useFileMeta"
import { useCellLabelsPreference } from "@/hooks/useCellLabelsPreference"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { eagerlyPrefetchPeaks } from "@/lib/audio/eager-peaks"
import { runTranscribeAll as runBatchTranscribeAll, runSynthAll as runBatchSynthAll } from "@/lib/audio/batch-audio"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { useOutbox } from "@/context/OutboxContext"
import { useReconcileOnDrain } from "@/hooks/useReconcileOnDrain"
import {
  setCqrsOutboxBridge,
  buildFileScopedTokenFetcher,
  buildProjectAwareMinter,
} from "@/lib/sync/cqrs-bridge"
import { emitTargetCellCommit, emitCellBacktranslationSet, emitFileRename, emitFileDelete, emitFileRestore, emitCellValidate, emitCellRetime, emitFileVideoSet } from "@/lib/sync/events-emit"
import type { AiDraftProvenance } from "@/lib/sync/outbox-types"
import { isBulkValidationEligible } from "@/lib/review/review-eligibility"
import { TimelineEditor } from "@/components/timeline/TimelineEditor"
import { applyPresenceFrame, applyLockClaimed, applyLockReleased } from "@/lib/sync/cell-lock-state"
import { canPerform, canOpenAssignUi } from "@/lib/sync/role-policy"
import { useFocusLock } from "@/hooks/useFocusLock"
import type { WsReconciler } from "@/lib/sync/ws-reconciler"
import {
  createProjectPresenceStore,
  usePresencePeers,
  type ProjectPresencePeer,
  type TargetPresenceSelection,
} from "@/lib/sync/presence-store"
import { flushOutboxBatch } from "@/lib/sync/outbox-flush"
import { invalidateCellHistory } from "@/lib/sync/history-invalidation"
import { runDiarization, type DiarizationPhase } from "@/lib/diarization/run-diarization"
import { attachMediaFileToTimeline, attachMediaUrlToTimeline } from "@/lib/timeline/attach-media"
import { useCellsAuditStatsWithOverlay } from "@/hooks/useCellsAuditStatsWithOverlay"
import { useComments } from "@/hooks/useComments"
import { Film, Scale, MessagesSquare, Share2, Settings as SettingsIcon, Lock, ClipboardList, Trash2, Undo2, Sparkles, BookMarked, BookOpen, Users, UserCheck, Eye, ArrowRight, PanelLeftClose, ListChecks, Loader2, X } from "lucide-react"
import { AgentDockPanel } from "./AgentDockPanel"
import { agentSessionStore } from "@/lib/agent/session-store"
import { AgentWorkbench } from "./agent/AgentWorkbench"
import type { ContextChip } from "@/lib/agent/context-chip"
import { CheckFindingsDrawer, checkScopeSummary } from "./CheckFindingsDrawer"
import { runDeterministicCheck, type CheckRunResult } from "@/lib/check/deterministic-check"
import { SearchDockPanel } from "./SearchDockPanel"
import { SearchResultsView } from "./search/SearchResultsView"
import { LeftDock, type DockTab } from "./LeftDock"
import { TranslationNotesSidebar, readTnSidebarVisible, writeTnSidebarVisible } from "./TranslationNotesSidebar"
import { ParallelBiblesSidebar, readParallelBiblesOpen, writeParallelBiblesOpen } from "./ParallelBiblesSidebar"
import { InactiveProjectBanner } from "./InactiveProjectBanner"
import { OfflineBanner } from "./OfflineBanner"
import { useProjectLifecycle } from "@/hooks/useProjectLifecycle"
import { restoreProject } from "@/lib/store/project-index"
import { AppShell } from "./AppShell"
import { WorkspaceHeader } from "./WorkspaceHeader"
import { DcsSyncBadgeMount } from "@/components/dcs/DcsSyncBadge"
import { EditorModeToggle } from "./EditorModeToggle"
import { audioLensLabel, audioLensIcon } from "@/lib/editor/audio-lens-label"
import { useEditorLensPreference } from "@/hooks/useEditorLensPreference"
import { SelectionBar } from "./SelectionBar"
import { WorkspaceStatusBar } from "./WorkspaceStatusBar"
import { PrimaryActionButton } from "./PrimaryActionButton"
import { ExpandableFileList } from "./ExpandableFileList"
import { SidebarProjectSection } from "./SidebarProjectSection"
import { SuggestionBanner } from "./SuggestionBanner"
import { ConfirmActionDialog } from "./ConfirmActionDialog"
import { PeerPresence } from "./PeerPresence"
import { ViewSettingsMenu, type ViewSettingsMenuHandle } from "./ViewSettingsMenu"
import type { OverflowMenuItem } from "./OverflowMenu"
import { useFootnotesPreference } from "@/hooks/useFootnotesPreference"
import type { VisibleFootnoteEntry } from "@/lib/footnotes/types"
import { deleteFootnote, spliceFootnoteText } from "@/lib/footnotes/splice"
import { useFileFontSizes, setFileViewPref } from "@/lib/store/file-view-prefs"
import { EditorScrollProvider, useEditorScroll } from "@/context/EditorScrollContext"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { detectSuggestions, type RenameSuggestion } from "@/lib/file-labeling/detect"
import { applySuggestions, buildUndo, hasEffectiveChange } from "@/lib/file-labeling/apply"
import { renameFile, moveFileToCorpus, renameCorpus, deleteFile } from "@/lib/store/file-operations"
import { deleteFileProjection } from "@/lib/sync/file-projection"
import { fetchDeletedFiles, fetchProjectFiles } from "@/lib/sync/cells-read"
import type { FileSummary } from "@/lib/sync/cells-read-types"
import { fileSummariesToProgress, mergeFileProgress } from "@/lib/progress/file-summary-progress"
import { invalidateFileProgress, invalidateProjectFileProgress, setLocalFileProgress } from "@/lib/progress/file-progress-resource"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import type { ProjectRecord } from "@/lib/parsers/types"
import { readValidationCount } from "@/lib/progress/read-validation-count"
import { summarizeTextDirections } from "@/lib/text-direction"
import { useSetupChecklist } from "@/hooks/useSetupChecklist"
import { SetupChecklistDrawer } from "./onboarding/SetupChecklistDrawer"
import { SystemPromptNudge } from "./onboarding/SystemPromptNudge"
import { CompletionBulkProgressBanner } from "./CompletionBulkProgressBanner"
import { AppTooltip, Tooltip, TooltipContent, TooltipDelegationBoundary, TooltipTrigger } from "@/components/ui/tooltip"
import { useNextUnfinished } from "@/hooks/useNextUnfinished"
import { AiSetupDialog } from "./AiSetupDialog"
import {
  buildProjectSettingsHandoffUrl,
  workspaceReturnPath,
} from "@/lib/ad11/navigation"
import { generateBacktranslation } from "@/lib/completion/backtranslation-service"
import { addConcept } from "@/lib/terminology/store"
import type { Concept } from "@/lib/terminology/types"
import { buildGlosser, type BtSeed, type Glosser } from "@/lib/completion/bt-glosser"
import { memMark } from "@/lib/perf-log"
import { buildAlignmentModel, type AlignmentModel } from "@/lib/completion/interlinear"
import { resolveBtTargetEventId } from "@/lib/completion/bt-auto"
// FRO-192: assignment work-pickup UI
import { AssignModal } from "./AssignModal"
import { ProjectAssignedToMe } from "./ProjectAssignedToMe"
import { getMyAssignments, getProjectAssignments, type MyAssignment, type AssigneeWorkload } from "@/lib/sync/assignments"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { getSelectedIds } from "@/lib/audio/selection"

// Import runs inline in the workspace (upload + eBible corpus tabs). The
// AD-11 plan carves import into a standalone apps/import Worker, but that
// app is still a placeholder shell — routing users there is a dead end.
// The import pipeline (parsers + outbox + events-emit) is workspace-
// internal and not yet extracted into a shared package the standalone app
// could consume, so the working ImportDialog stays hosted here. Lazy-loaded
// because the eBible parser bundles a ~2MB vref table.
const ImportDialog = lazy(() =>
  import("./ImportDialog").then((mod) => ({ default: mod.ImportDialog })),
)

const ExportDialog = lazy(() =>
  import("./ExportDialog").then((mod) => ({ default: mod.ExportDialog })),
)

// File-scoped target import: populate the open file's target column from
// USFM or a spreadsheet. Lazy — pulls in the XLSX parser.
const FileTargetImportDialog = lazy(() =>
  import("./FileTargetImportDialog").then((mod) => ({ default: mod.FileTargetImportDialog })),
)

// FRO-254: In-project views rendered inside the editor shell. Lazy-loaded so
// the heavy workspace chunk doesn't pull them in for every route.
const CommentsPageContent = lazy(() =>
  import("./CommentsPage").then((mod) => ({ default: mod.CommentsPage })),
)
const LivingMemoryPageContent = lazy(() =>
  import("./LivingMemoryPage").then((mod) => ({ default: mod.LivingMemoryPage })),
)
const GlossaryEditorContent = lazy(() =>
  import("./GlossaryEditor").then((mod) => ({ default: mod.GlossaryEditor })),
)
// FRO-180: per-project members management surface.
const ProjectMembersPageContent = lazy(() =>
  import("./ProjectMembersPage").then((mod) => ({ default: mod.ProjectMembersPage })),
)
// FRO-249 fix (Fix 2): module-level promise chain that serializes
// handleImported's getProject→updateProject read-modify-write so that
// concurrent imports don't race and the last write doesn't silently drop
// earlier refs. This is module-scoped (not component-scoped) deliberately —
// a single ProjectWorkspace is mounted at a time and the chain must survive
// between React re-renders.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _lastImportWrite: Promise<any> = Promise.resolve(undefined)
const EMPTY_CELL_DATA: CellData[] = []

function projectRecordsEquivalent(a: ProjectRecord | null, b: ProjectRecord | null): boolean {
  if (a === b) return true
  if (!a || !b) return a === b
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

// ── FRO-234: pure guard — exported for unit testing ───────────────────────────
/**
 * Returns true iff the completion-settings save should actually patch
 * systemPrompt on the server. Guards against two failure modes:
 *   1. Empty-prompt clobber: buildCompletionSettings() materialises "" by
 *      default, so provider-only saves would erase the server prompt.
 *   2. Under-MAINTAINER write: sub-600 callers 403 server-side; skipping
 *      avoids IDB/server divergence (same floor as handleImported).
 */
export function shouldPatchSystemPrompt(
  systemPrompt: string | null | undefined,
  roleLevel: number,
): boolean {
  if (!systemPrompt || systemPrompt.trim().length === 0) return false
  return roleLevel >= ROLE.MAINTAINER
}

// ── QA-BUG-1: pure guard — exported for unit testing ─────────────────────────
/**
 * Returns true iff the zero-file self-heal should fire a `/link/sync`
 * trigger for the current project. Only live-linked projects can be
 * self-healed this way (clone links never sync again after creation — the
 * QA-flagged gap there is closed at link time in the auth-worker route, not
 * here). Guards against re-firing for a project that already has files (the
 * common case, and the state right after a successful heal) and against
 * re-firing for the SAME project id more than once per mount (the caller
 * tracks `alreadyAttemptedProjectId` across renders via a ref).
 */
export function shouldSelfHealZeroFileLink(args: {
  projectId: string | null | undefined
  jwt: string | null | undefined
  sourceLinkMode: "clone" | "live" | null | undefined
  fileCount: number
  alreadyAttemptedProjectId: string | null
}): boolean {
  const { projectId, jwt, sourceLinkMode, fileCount, alreadyAttemptedProjectId } = args
  if (!projectId || !jwt) return false
  if (sourceLinkMode !== "live") return false
  if (fileCount > 0) return false
  if (alreadyAttemptedProjectId === projectId) return false
  return true
}

/**
 * A deterministic check run describes ONE file's cells. If the user switches
 * files while the (async) run is in flight, its result must not be committed —
 * it would clobber the now-active file's state with the prior file's findings.
 * Apply a result only when it still matches the currently-active file.
 */
export function shouldApplyCheckResult(
  resultFileId: string | null,
  activeFileId: string | null,
): boolean {
  return resultFileId != null && resultFileId === activeFileId
}

const PRESENCE_LOCK_STALE_CLEAR_MS = 31_000

function sameStringMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false
  }
  return true
}

// AQU-538 (slice 2): per-project persistence of the active target lane.
// `''` (default lane) is stored as "no key" so a single-lane project keeps a
// clean localStorage — reading a missing key yields the default lane.
function activeLaneStorageKey(projectId: string): string {
  return `aquilla:activeLane:${projectId}`
}
function readPersistedActiveLane(projectId: string): string {
  try {
    return localStorage.getItem(activeLaneStorageKey(projectId)) ?? ""
  } catch {
    return ""
  }
}
function writePersistedActiveLane(projectId: string, lane: string): void {
  try {
    if (lane) localStorage.setItem(activeLaneStorageKey(projectId), lane)
    else localStorage.removeItem(activeLaneStorageKey(projectId))
  } catch {
    /* storage unavailable (private mode / quota) — lane stays in-memory only */
  }
}

export function ProjectWorkspace() {
  const { id: projectId, fileId: routeFileId } = useParams<{ id: string; fileId?: string }>()
  const navigate = useNavigate()
  const { orgs, activeOrg, activeOrgId, isAllOrgs, refresh: refreshOrgs } = useActiveOrg()
  const goToProjects = useCallback(() => {
    navigate({
      pathname: "/",
      search: isAllOrgs ? "?org=all" : activeOrgId != null ? `?org=${activeOrgId}` : "",
    })
  }, [activeOrgId, isAllOrgs, navigate])
  const { project: loadedProject, status, refresh, patchSettings, roleLevel: serverRoleLevel } = useProject(projectId!)
  // Client-local overlays (corpusMarker, originalName, suggestionsDismissedAt)
  // live in IDB; merge them onto the server-fetched record on load and after
  // each local patch so rename suggestions don't loop on every open.
  const [clientProject, setClientProject] = useState<ProjectRecord | null>(null)

  useEffect(() => {
    if (!loadedProject) {
      setClientProject((current) => current === null ? current : null)
      return
    }
    let cancelled = false
    void getProject(loadedProject.id).then((local) => {
      if (cancelled) return
      const next = mergeServerProjectWithLocalCache(loadedProject, local)
      setClientProject((current) => projectRecordsEquivalent(current, next) ? current : next)
    })
    return () => { cancelled = true }
  }, [loadedProject])

  const hydratedProject = clientProject ?? loadedProject

  const [selectedFileId, setSelectedFileId] = useState<string | null>(routeFileId ?? null)
  const activeFileId = routeFileId ?? selectedFileId
  // Latest active file, readable from async callbacks that outlive a file
  // switch (e.g. runCheck) without capturing a stale closure value.
  const activeFileIdRef = useRef<string | null>(activeFileId)
  activeFileIdRef.current = activeFileId

  const setActiveFileId = useCallback((fileId: string | null) => {
    if (!projectId) return
    setSelectedFileId(fileId)
    if (fileId) {
      navigate(`/project/${projectId}/file/${fileId}`)
    } else {
      navigate(`/project/${projectId}`)
    }
  }, [projectId, navigate])
  useEffect(() => {
    if (routeFileId) setSelectedFileId(routeFileId)
  }, [routeFileId])
  const [optimisticFiles, setOptimisticFiles] = useState<FileReference[]>([])
  const optimisticFileIdsRef = useRef<Set<string>>(new Set())
  const orgRefreshAttemptedForProjectRef = useRef<number | null>(null)
  // Optimistic file-label renames (fileId → new name), applied locally before
  // the file.rename event round-trips so the new label shows instantly.
  const [optimisticRenames, setOptimisticRenames] = useState<Map<string, string>>(new Map())
  // FRO-272: soft-deleted file ids hidden from the sidebar until the server
  // read reflects the file.delete event. Same class as optimistic renames —
  // patchProject(IDB) writes are invisible (useProject reads server), so
  // without this overlay a deleted file lingers until the outbox flushes and
  // a later refetch happens to run.
  const [optimisticDeletes, setOptimisticDeletes] = useState<Set<string>>(new Set())
  // Session-local dismissal of the rename-suggestion banner. (Persisting this
  // across reloads would need server backing; the in-session state is what the
  // X button and "apply" flows actually need.)
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  // Transient bottom-right status notice. Originally the FRO-249/FRO-255
  // direction-role notice; now shared by any flow that needs a post-action
  // result confirmation (e.g. the AQU-314 label import). Severity tints follow
  // the workspace banner idiom (amber warnings, etc.). Only success notices
  // auto-dismiss (6 s) — error/warning/info stay until the user closes them.
  const [transientNotice, setTransientNotice] = useState<{
    message: string
    severity: "error" | "warning" | "success" | "info"
  } | null>(null)
  useEffect(() => {
    if (transientNotice?.severity !== "success") return
    const t = setTimeout(() => setTransientNotice(null), 6000)
    return () => clearTimeout(t)
  }, [transientNotice])
  useEffect(() => {
    optimisticFileIdsRef.current = new Set()
    setOptimisticFiles([])
    setOptimisticRenames(new Map())
    setOptimisticDeletes(new Set())
    setSuggestionsDismissed(false)
    setClientProject(null)
  }, [projectId])

  const projectFiles = useMemo(() => {
    const serverFiles = hydratedProject?.files ?? []
    // Overlay optimistic renames so the new label shows instantly and
    // detectSuggestions drops the applied file from the banner. Reconciled away
    // by the effect below once the server read reflects the new name.
    let base = optimisticRenames.size === 0
      ? serverFiles
      : serverFiles.map((file) => {
          const renamed = optimisticRenames.get(file.id)
          return renamed !== undefined && renamed !== file.name ? { ...file, name: renamed } : file
        })
    // Hide optimistically soft-deleted files until the server read drops them.
    if (optimisticDeletes.size > 0) {
      const filtered = base.filter((file) => !optimisticDeletes.has(file.id))
      if (filtered.length !== base.length) base = filtered
    }
    if (optimisticFiles.length === 0) return base

    const seen = new Set(base.map((file) => file.id))
    const pending = optimisticFiles.filter(
      (file) => !seen.has(file.id) && !optimisticDeletes.has(file.id),
    )
    return pending.length > 0 ? [...base, ...pending] : base
  }, [hydratedProject?.files, optimisticFiles, optimisticRenames, optimisticDeletes])

  // AQU-314: id+name pairs for the Cell-labels import panel's file picker.
  const labelPickerFiles = useMemo(
    () => projectFiles.map((f) => ({ id: f.id, name: f.name })),
    [projectFiles],
  )

  const project = useMemo<ProjectRecord | null>(() => {
    if (!hydratedProject) return null
    if (projectFiles === hydratedProject.files) return hydratedProject
    return { ...hydratedProject, files: projectFiles }
  }, [hydratedProject, projectFiles])

  useEffect(() => {
    if (project?.orgId == null) return
    if (orgs.some((org) => org.id === project.orgId)) {
      orgRefreshAttemptedForProjectRef.current = null
      return
    }
    if (orgRefreshAttemptedForProjectRef.current === project.orgId) return
    orgRefreshAttemptedForProjectRef.current = project.orgId
    void refreshOrgs()
  }, [orgs, project?.orgId, refreshOrgs])

  const projectOrg = useMemo(() => {
    if (project?.orgId == null) return activeOrg
    if (activeOrg?.id === project.orgId) return activeOrg
    return orgs.find((org) => org.id === project.orgId) ?? null
  }, [activeOrg, orgs, project?.orgId])

  useEffect(() => {
    if (!hydratedProject || optimisticFiles.length === 0) return
    const serverIds = new Set(hydratedProject.files.map((file) => file.id))
    setOptimisticFiles((current) => {
      const next = current.filter((file) => !serverIds.has(file.id))
      optimisticFileIdsRef.current = new Set(next.map((file) => file.id))
      return next
    })
  }, [hydratedProject, optimisticFiles.length])

  // Drop an optimistic delete once the server read no longer returns the file.
  useEffect(() => {
    if (!hydratedProject || optimisticDeletes.size === 0) return
    const serverIds = new Set(hydratedProject.files.map((file) => file.id))
    setOptimisticDeletes((current) => {
      let changed = false
      const next = new Set(current)
      for (const id of current) {
        if (!serverIds.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [hydratedProject, optimisticDeletes.size])

  // Drop an optimistic rename once the server read carries the new name.
  useEffect(() => {
    if (!hydratedProject || optimisticRenames.size === 0) return
    setOptimisticRenames((current) => {
      let changed = false
      const next = new Map(current)
      for (const file of hydratedProject.files) {
        if (next.get(file.id) === file.name) {
          next.delete(file.id)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [hydratedProject, optimisticRenames.size])

  const fileIds = useMemo(() => projectFiles.map((f) => f.id), [projectFiles])
  useEffect(() => {
    if (!selectedFileId || fileIds.length === 0 || fileIds.includes(selectedFileId)) return
    setSelectedFileId(null)
  }, [selectedFileId, fileIds])
  const workspaceTabs = useWorkspaceTabs({
    projectId: projectId ?? "",
    fileIds,
    filesReady: Boolean(project),
    activeFileId,
    setActiveFileId,
  })

  const allTabsClosedRef = useRef(false)
  const handleCloseTab = useCallback(
    (tabId: string) => {
      const isLastTab =
        workspaceTabs.tabs.length === 1 && workspaceTabs.tabs[0]?.id === tabId
      if (isLastTab && projectId) {
        allTabsClosedRef.current = true
        clearLastLocation(currentUsernameRef.current, projectId)
      }
      workspaceTabs.closeTab(tabId)
    },
    [workspaceTabs, projectId],
  )

  // Single source of truth for the fileId in the URL. This used to be two
  // separate effects — one that *restored* a file when the URL had none
  // (after a detour through Rules/Comments), and one further down
  // that *stripped* a fileId the project didn't recognize. They fought:
  // restore → strip → restore → …, each hop a `navigate({replace:true})` =
  // a `history.replaceState`. The browser caps that at 100/10s and throws
  // SecurityError, and the re-render storm also tore the project WebSocket
  // down before it could connect. Merging them — and only navigating when
  // the destination differs from the current path — makes the redirect
  // converge in one hop. Reads localStorage directly because it only needs
  // to fire on the no-fileId render.
  const location = useLocation()

  // Upgrade this route's back/forward history entry to a human-readable label
  // (e.g. "Genesis · Editor" or "Genesis · Luke") once the project has loaded.
  const navHistoryTitle = useMemo(() => {
    if (!project) return null
    // Use the URL's file id (not the persisted selection) so a content surface
    // like /comments is labelled "Comments", not the last-opened file.
    const fileName = routeFileId
      ? projectFiles.find((f) => f.id === routeFileId)?.name
      : undefined
    if (fileName) return `${project.name} · ${fileName}`
    const section = deriveNavTitle(location.pathname)
    return section === "Editor" ? project.name : `${project.name} · ${section}`
  }, [project, routeFileId, projectFiles, location.pathname])
  useNavHistoryTitle(navHistoryTitle)

  // `navigate(replace)` calls `history.replaceState` synchronously, but the
  // matching `useLocation()` / `useParams()` update only lands on a later
  // commit. During an import the WS reconnect + revalidate + optimistic-file
  // reconciliation drive a burst of renders, and this effect re-runs on every
  // one (its `project` dep is a fresh object each render). Guarding solely on
  // `location.pathname` isn't enough: across the burst it stays stale, so the
  // same `navigate(replace)` fires dozens of times before the URL settles —
  // tripping the browser's 100-replaceState/10s cap (SecurityError → blank
  // page). `pendingNavRef` remembers the target we last issued and suppresses
  // a repeat until the router actually commits it.
  const pendingNavRef = useRef<string | null>(null)
  const redirectTo = useCallback(
    (target: string) => {
      if (location.pathname === target) {
        pendingNavRef.current = null
        return false
      }
      if (pendingNavRef.current === target) return false
      pendingNavRef.current = target
      navigate(target, { replace: true })
      return true
    },
    [location.pathname, navigate],
  )
  useEffect(() => {
    if (!project || !projectId) return

    // The in-project overlay surfaces (/rules, /comments, /memory, /terminology,
    // /members) deliberately carry no file in the URL — don't treat that as
    // "no file selected" and bounce back to the editor, or these surfaces become
    // unreachable. (FRO-194 added /rules; FRO-254 adds the others; FRO-180 adds /members.)
    if (
      location.pathname.endsWith("/rules") ||
      location.pathname.endsWith("/comments") ||
      location.pathname.endsWith("/memory") ||
      location.pathname.endsWith("/terminology") ||
      location.pathname.endsWith("/members") ||
      location.pathname.endsWith("/agent")
    ) return

    // A file is already in the URL: leave it unless the project genuinely
    // doesn't have it (and it isn't a still-pending optimistic import).
    if (routeFileId) {
      const known =
        fileIds.includes(routeFileId) ||
        optimisticFileIdsRef.current.has(routeFileId)
      if (known) {
        pendingNavRef.current = null
        return
      }
      redirectTo(`/project/${projectId}`)
      return
    }

    // User explicitly closed all tabs — don't auto-restore a file.
    if (allTabsClosedRef.current) {
      allTabsClosedRef.current = false
      return
    }

    // No file in the URL: restore the last/only file if there is a valid one.
    // Prefer the richer per-user last-location store; fall back to the
    // legacy readLastActiveFileId (tabs-only) for backward compat.
    // NOTE: currentUsernameRef.current is read here (not the derived const)
    // because this effect is declared before currentUsername is computed.
    const uid = currentUsernameRef.current
    const savedLoc = readLastLocation(uid, projectId)
    const last = (savedLoc?.fileId && fileIds.includes(savedLoc.fileId) ? savedLoc.fileId : null)
      ?? readLastActiveFileId(projectId)
    const firstOpenTab = workspaceTabs.tabs[0]?.fileId ?? null
    const onlyFile = projectFiles.length === 1 ? projectFiles[0]?.id : null
    const nextFileId =
      last && fileIds.includes(last)
        ? last
        : firstOpenTab && fileIds.includes(firstOpenTab)
          ? firstOpenTab
          : onlyFile
    if (!nextFileId) return
    // If there is a remembered cell, park it in the ref so the scroll-restore
    // effect can consume it once cells are loaded.
    if (savedLoc?.cellId && savedLoc.fileId === nextFileId) {
      pendingCellScrollRef.current = savedLoc.cellId
    }
    const target = `/project/${projectId}/file/${nextFileId}`
    if (redirectTo(target)) setSelectedFileId(nextFileId)
  }, [
    project,
    projectId,
    routeFileId,
    fileIds,
    projectFiles,
    workspaceTabs.tabs,
    redirectTo,
  ])
  const [importOpen, setImportOpen] = useState(false)
  // File-scoped target import dialog ("Import target translations into this file").
  const [fileImportOpen, setFileImportOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [drawerRuleId, setDrawerRuleId] = useState<string | null>(null)
  const [searchParams] = useSearchParams()

  // Center surface — derived from the URL path so deep-links work and the
  // shell (sidebar + top bar + bottom status bar) never unmounts.
  // FRO-194 added "rules"; FRO-254 adds "comments", "memory", "terminology";
  // FRO-180 adds "members".
  const centerSurface: "editor" | "rules" | "comments" | "memory" | "terminology" | "members" | "agent" =
    location.pathname.endsWith("/rules") ? "rules" :
    location.pathname.endsWith("/comments") ? "comments" :
    location.pathname.endsWith("/memory") ? "memory" :
    location.pathname.endsWith("/terminology") ? "terminology" :
    location.pathname.endsWith("/members") ? "members" :
    location.pathname.endsWith("/agent") ? "agent" :
    "editor"

  const [editingRuleId, setEditingRuleId] = useState<string | "new" | null>(null)

  useEffect(() => {
    const open = searchParams.get("openRule")
    if (open) setDrawerRuleId(open)
  }, [searchParams])

  // FRO-295: CommentsPage deep-links here with ?cellId=<id>. Park the value so
  // the scroll-restore effect (below) can consume it once cells are loaded.
  useEffect(() => {
    const cellId = searchParams.get("cellId")
    if (cellId) pendingCellScrollRef.current = cellId
  }, [searchParams])
  const [commentsCellId, setCommentsCellId] = useState<string | null>(null)
  const [historyCellId, setHistoryCellId] = useState<string | null>(null)
  // Phase 0.5 deterministic "Check file" (agentic-harness strategy §4, no
  // LLM). Findings are session-local: held here, never persisted or synced.
  const [checkOpen, setCheckOpen] = useState(false)
  const [checkRunning, setCheckRunning] = useState(false)
  const [checkResult, setCheckResult] = useState<CheckRunResult | null>(null)
  const [parallelOpen, setParallelOpen] = useState(false)
  const [parallelMode, setParallelMode] = useState<ParallelPanelMode>("search")
  const [parallelScope, setParallelScope] = useState<ParallelPanelScope>("project")
  const [shareOpen, setShareOpen] = useState(false)
  // FRO-308: left dock active tab (null = collapsed rail only)
  const [dockTab, setDockTab] = useState<DockTab | null>("files")
  // Agent workbench (agent-mode-v2 §4) is a takeover surface: collapse the
  // dock to the rail on entry (a second agent chat beside the workbench is
  // confusing) and restore the user's tab on exit. Manual reopen still wins —
  // this only fires on surface transitions.
  const dockTabBeforeAgentRef = useRef<DockTab | null>("files")
  const prevSurfaceRef = useRef(centerSurface)
  useEffect(() => {
    const prev = prevSurfaceRef.current
    prevSurfaceRef.current = centerSurface
    if (centerSurface === "agent" && prev !== "agent") {
      dockTabBeforeAgentRef.current = dockTab
      // The file explorer is the workbench's scope picker — open it by
      // default (the Agent tab itself stays unreachable during the takeover).
      setDockTab("files")
    } else if (centerSurface !== "agent" && prev === "agent") {
      setDockTab((cur) => cur ?? dockTabBeforeAgentRef.current)
    } else if (centerSurface === "agent" && dockTab === "agent") {
      // Restore/route paths can re-land the agent tab mid-takeover; collapse.
      setDockTab(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dockTab read on transition only
  }, [centerSurface])
  // Agent working area (agent-complete follow-up): in the workbench the file
  // explorer doubles as the SCOPE PICKER — clicking a file designates what the
  // agent works on instead of opening the editor. Falls back to the editor's
  // active file until the user picks one; cleared when they leave the surface
  // (the editor's own focus is the scope again).
  const [agentScopeFileId, setAgentScopeFileId] = useState<string | null>(null)
  useEffect(() => {
    if (centerSurface !== "agent") setAgentScopeFileId(null)
  }, [centerSurface])
  const agentScopeFile = useMemo(() => {
    const id = agentScopeFileId ?? activeFileId
    return id ? projectFiles.find((f) => f.id === id) ?? null : null
  }, [agentScopeFileId, activeFileId, projectFiles])

  // A source selection the user sent to the agent via "Ask AI". Opens the
  // Agent dock and is inserted into the composer as a context chip.
  const [pendingChip, setPendingChip] = useState<ContextChip | null>(null)
  const handleAskAiFromSelection = useCallback((chip: ContextChip) => {
    setPendingChip(chip)
    setDockTab("agent")
  }, [])
  // FRO-309: expanded search results overlay in the main area
  const [searchExpandedQuery, setSearchExpandedQuery] = useState<string | null>(null)
  const [aiSetupOpen, setAiSetupOpen] = useState(false)
  const [recordingCellId, setRecordingCellId] = useState<string | null>(null)
  // "Make a character from this voice" dialog (Cast studio). Owned here so the
  // per-cell control in the editor's source column can open it seeded to a
  // specific line's take, and the rail's button can open it for a manual pick.
  const [makeCharacterOpen, setMakeCharacterOpen] = useState(false)
  const [makeCharacterSeedCellId, setMakeCharacterSeedCellId] = useState<string | null>(null)
  // FRO-192: Assign… modal
  const [assignModalOpen, setAssignModalOpen] = useState(false)
  // Increment to force a refresh of the assignments pickup panel after a new
  // assignment is created. The EditorTable assignmentsByCellId map is also
  // rebuilt on the same tick.
  const [assignmentsRefreshKey, setAssignmentsRefreshKey] = useState(0)
  // After "Voice together" synthesizes one combined clip, hold its result so
  // the manual boundary editor can open for the user to mark per-line slices.
  const [combinedEditor, setCombinedEditor] = useState<CombinedVoiceResult | null>(null)
  // Text vs Audio lens — the same editor over the same cells. Audio mode swaps
  // the left rail's body for the Cast studio (VoiceSidebar: cast roster + the
  // "make a character" dialog) and replaces each cell's SOURCE column with that
  // line's voice controls (CellVoicePanel); all other audio chrome lives there.
  const [lens, setLens] = useEditorLensPreference(projectId ?? "")
  // ISSUE-3 fix: /project/:id/voice deep-link activates audio lens on mount,
  // and surfaces the Voices dock tab (where the voice controls now live).
  useEffect(() => {
    if (location.pathname.endsWith("/voice")) { setLens("audio"); setDockTab("voices") }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])
  // A2: "Open audio setup" CTA from the cell error popover must navigate to a
  // page where the Gemini API key can be set. The old implementation called
  // setLens("audio") which is a no-op when already in audio mode. Navigate to
  // project settings instead so the key field is always reachable.
  // AQU-522: deep-link with `?q=gemini` so settings opens filtered to the Voice
  // card — the Gemini/TTS key entry is then visible without scrolling to find it.
  const openAudioSetup = useCallback(() => {
    if (!projectId) return
    navigate(`/project/${projectId}/settings?q=gemini`)
  }, [navigate, projectId])
  const editorRef = useRef<EditorTableHandle>(null)
  const viewSettingsRef = useRef<ViewSettingsMenuHandle>(null)
  // Holds a cellId to scroll to once cells are loaded after a restore-location
  // navigation. Set during the restore effect, consumed (and cleared) by a
  // separate effect that fires when `cells` are available.
  const pendingCellScrollRef = useRef<string | null>(null)
  // Mirrors currentUsername (computed later in the function) so effects that
  // are declared before currentUsername can access it via ref.
  const currentUsernameRef = useRef<string>("local")
  // Phase 2c-gamma: the per-file Y.Doc is gone. The editor hydrates from the
  // cells projection and writes via the outbox. `doc`/`docLoading` are
  // retained as no-op constants so downstream cellAreaState + props don't
  // need a wider refactor.
  const doc: null = null
  // Prefer the Frontier session username (authenticated identity) over the
  // project-level username setting. Validation entries and edit history
  // should attribute to the actual signed-in user.
  const { session: frontierSession, logout: doLogout } = useFrontierSession()
  const currentUsername = frontierSession?.username || project?.username || "local"
  // Keep the ref in sync so effects declared earlier in the component can
  // access the resolved username without a hoisting issue.
  currentUsernameRef.current = currentUsername
  const presenceStore = useMemo(
    () => createProjectPresenceStore(currentUsername),
    [currentUsername, project?.id],
  )
  const presencePeers = usePresencePeers(presenceStore)
  const jwtRef = useRef<string | null>(null)
  useEffect(() => {
    jwtRef.current = frontierSession?.jwt ?? null
  }, [frontierSession?.jwt])

  // FRO-214 (orchestrator glue): frozen-project state for the workspace banner.
  const { isFrozen, toggle: toggleLifecycle, busy: lifecycleBusy } = useProjectLifecycle(projectId ?? "", project, () => refresh())

  const getTokenForFile = useMemo(() => {
    if (!project?.id) {
      return async (_fileId: string) => null as string | null
    }
    const pid = project.id
    const bootstrap = {
      projectName: project.name ?? undefined,
      gitlabProjectId:
        project.origin?.kind === "git" ? project.origin.gitlabProjectId : undefined,
    }
    return buildFileScopedTokenFetcher(
      () => jwtRef.current,
      pid,
      bootstrap,
      undefined,
      {
        onRole: (role) => {
          void patchProject(pid, (p) => ({
            ...p,
            syncRole: {
              level: role.level,
              name: role.name,
              source: role.source,
              fetchedAt: new Date().toISOString(),
            },
          }))
        },
        onUnauthorized: () => {
          // FRO-159: The stored session JWT was rejected by the auth server (401).
          // This happens after a backend migration (e.g. Postgres switch) that
          // invalidates existing tokens. Clear the session so the user is
          // redirected to login rather than silently failing on every file open.
          console.warn("[ProjectWorkspace] session JWT rejected (401) — clearing session for re-auth")
          void doLogout().then(() => navigate("/"))
        },
      },
    )
  }, [
    project?.id,
    project?.name,
    project?.origin?.kind,
    project?.origin?.kind === "git" ? project?.origin.gitlabProjectId : undefined,
    doLogout,
    navigate,
  ])

  // Project-AWARE fetcher for the outbox flusher. The outbox is global across
  // every project the user touches, so the flusher must mint a token for each
  // event's OWN projectId — not the workspace's active project. Minting against
  // the active project is what produced "403 token scoped to different project"
  // on events queued elsewhere, head-of-line blocking the whole queue. Stable
  // across project switches (keyed on nothing project-specific) so a single
  // background drain serves all projects.
  const getTokenForProjectFile = useMemo(() => {
    return buildProjectAwareMinter(() => jwtRef.current, undefined, {
      onUnauthorized: () => {
        // Only a /sync-token mint 401 (the session JWT itself is dead) reaches
        // here — that genuinely means re-auth. A per-event 403 does NOT, so the
        // outbox banner no longer mislabels permission failures as "session
        // expired" (FRO-xxx).
        console.warn("[ProjectWorkspace] session JWT rejected (401) during outbox drain — clearing session")
        void doLogout().then(() => navigate("/"))
      },
    })
  }, [doLogout, navigate])

  useEffect(() => {
    if (!project?.id || !activeFileId) {
      setCqrsOutboxBridge(null)
      return
    }
    setCqrsOutboxBridge({
      projectId: project.id,
      activeFileId,
      username: currentUsername,
      roleLevel: project.syncRole?.level ?? null,
    })
    return () => setCqrsOutboxBridge(null)
  }, [project?.id, activeFileId, currentUsername, project?.syncRole?.level])

  // The outbox drain loop is owned by the app-shell OutboxProvider (FRO-221)
  // so the queue drains on every route, not just inside a project. We consume
  // its state here for the status-bar indicator and the stale-edit banners.
  // `getTokenForProjectFile` (local minter) is still used below for the
  // best-effort "flush immediately after this action" nudges.
  const {
    pendingCount: outboxPending,
    failedCount: outboxFailed,
    failureStreak: outboxFailures,
    refreshPending: refreshOutboxPending,
    flushNow: outboxFlushNow,
    records: outboxRecords,
    staleSiblingCount: outboxStaleSiblingCount,
    staleSiblingEntries: outboxStaleSiblingEntries,
    clearStaleSiblings: clearStaleSiblings,
    staleSourceCount: outboxStaleSourceCount,
  } = useOutbox()
  // F5/F6: dismiss the notification banners after the user has seen them.
  // For stale siblings the banner is also dismissed implicitly when the
  // user clicks "View in history" (we navigate them to the conflict — they
  // shouldn't have to dismiss separately).
  const [staleSourceBannerDismissed, setStaleSourceBannerDismissed] = useState(0)
  // FRO-274: write-failure banner for BT persist failures (outbox enqueue
  // fails — IndexedDB unavailable, quota exceeded, etc.).
  const [btWriteError, setBtWriteError] = useState<string | null>(null)
  const showStaleSiblingBanner =
    outboxStaleSiblingCount > 0 && outboxStaleSiblingEntries.length > 0
  const showStaleSourceBanner = outboxStaleSourceCount > staleSourceBannerDismissed

  // D1-backed audit stats for the active file with the client outbox applied
  // on top — pending commits/validates show up immediately, before the next
  // 30s refetch. Source of truth for project-wide validation views.
  const auditStatsEnabled = Boolean(project?.id && activeFileId && frontierSession?.jwt)
  const {
    byCellId: auditStatsByCellId,
    revalidate: revalidateAuditStats,
    revalidateCellStats,
  } = useCellsAuditStatsWithOverlay({
    enabled: auditStatsEnabled,
    fileId: activeFileId,
    getTokenForFile,
  })

  const validationCount = project ? readValidationCount(project) : 1
  // AQU-538: the active target lane. Declared here (above useActiveCellStore)
  // because the store's cell list is lane-filtered on this value. Persisted
  // per-project; N=1 is always `''` (no switcher rendered, byte-identical).
  const [activeLane, setActiveLaneState] = useState<string>(() =>
    projectId ? readPersistedActiveLane(projectId) : "",
  )
  // Reload the persisted lane when navigating between projects.
  useEffect(() => {
    setActiveLaneState(projectId ? readPersistedActiveLane(projectId) : "")
  }, [projectId])
  // AQU-538: useActiveCellStore serves the ACTUAL workspace cell list; it now
  // filters target rows to `activeLane` (same `(r.targetLang ?? '') === lane`
  // rule as useCells) before the one-target-per-cell pairing. N=1 is
  // byte-identical (only default-lane rows exist).
  const {
    store: cellStore,
    revalidate: revalidateCells,
    revalidateCell,
    applyOptimisticTargetEdit,
    applyOptimisticTargetEdits,
    isLoading: cellsLoading,
  } = useActiveCellStore({
    projectId: project?.id ?? null,
    fileId: activeFileId,
    username: currentUsername,
    requiredValidations: validationCount,
    auditStats: auditStatsByCellId,
    getToken: getTokenForFile,
    enabled: Boolean(project?.id && activeFileId && frontierSession?.jwt),
    lane: activeLane,
  })
  const cellStoreVersion = useCellStoreVersion(cellStore)
  const cellSummaries = useMemo(() => readAtVersion(cellStoreVersion, () => cellStore.getAllSummaries()), [cellStore, cellStoreVersion])
  const localFileProgress = useMemo(() => readAtVersion(cellStoreVersion, () => cellStore.getFileProgressSnapshot()), [cellStore, cellStoreVersion])
  useEffect(() => {
    if (!project?.id || !activeFileId || !localFileProgress) return
    readAtVersion(cellStoreVersion, () => setLocalFileProgress(
      project.id,
      activeFileId,
      localFileProgress,
      cellStore.getPendingProgressEventIds(),
    ))
  }, [activeFileId, cellStore, cellStoreVersion, localFileProgress, project?.id])
  const getActiveCells = useCallback(() => cellStore.getAllCellViews(), [cellStore])
  const getActiveCell = useCallback((cellId: string) => cellStore.getCellView(cellId), [cellStore])

  // FRO-IMPORT-OPT: when the active file's queued target commits finish draining
  // to the server, do ONE soft refetch to reconcile the read model and clear the
  // optimistic shadows an import left behind (no per-cell fan-out).
  const activeFilePendingCommits = useMemo(
    () =>
      outboxRecords.filter(
        (r) => r.event.fileId === activeFileId && r.event.kind === "target.cell.commit",
      ).length,
    [outboxRecords, activeFileId],
  )
  useReconcileOnDrain(activeFilePendingCommits, activeFileId, revalidateCells)

  // QA-BUG-1: zero-file self-heal for live-linked projects. The lazy-pull
  // trigger in useStaleSourceCells only fires once a FILE is open — a
  // freshly linked (or link-time-seed-failed) project has none, so there was
  // no client path that could ever recover it. Fire /link/sync once per
  // project load when the project is live-linked and its file list is
  // empty; on success, `refresh()` pulls the now-populated file list. Clone
  // links correctly no-op server-side (mirrorSync short-circuits for
  // mode='clone') so this is safe to fire unconditionally for any live link.
  const zeroFileHealAttemptedRef = useRef<string | null>(null)
  useEffect(() => {
    const pid = project?.id ?? null
    const jwt = frontierSession?.jwt ?? null
    if (!shouldSelfHealZeroFileLink({
      projectId: pid,
      jwt,
      sourceLinkMode: project?.sourceLinkMode,
      fileCount: projectFiles.length,
      alreadyAttemptedProjectId: zeroFileHealAttemptedRef.current,
    })) return
    zeroFileHealAttemptedRef.current = pid
    void (async () => {
      const ok = await triggerLinkSync(jwt!, pid!)
      if (ok) refresh()
    })()
  }, [project?.id, project?.sourceLinkMode, projectFiles.length, frontierSession?.jwt, refresh])

  // Track the last cell that received an optimistic target edit so
  // `handleCellCommitted` can fall back to a targeted revalidate when the
  // caller didn't pass a cellId. EditorTable calls applyOptimisticTargetEdit
  // immediately before emitting the commit event, so this ref is always
  // up-to-date by the time onCellCommitted fires.
  const lastOptimisticEditRef = useRef<{ cellId: string } | null>(null)
  const pendingTargetCommitHeadsRef = useRef<Map<string, { eventId: string; parentId: string | null }>>(new Map())

  // RACE-3/QW-2: per-cell pending event id for the AI completion commit path.
  // Mirrors the per-row pendingTargetEventIdRef in EditorRow. Keyed by cellId
  // so concurrent completions on different cells don't cross-contaminate.
  const pendingCompletionEventIdRef = useRef<Map<string, string>>(new Map())

  const glosserCacheRef = useRef<{
    corpusCells: readonly CellSummary[]
    backtranslationCache: Map<string, string>
    terminology: ProjectRecord["terminology"] | undefined
    glosser: Glosser
  } | null>(null)
  const alignmentModelCacheRef = useRef<{
    corpusCells: readonly CellSummary[]
    alignmentSeeds: ProjectRecord["alignmentSeeds"] | undefined
    model: AlignmentModel
  } | null>(null)

  // Wrap applyOptimisticTargetEdit to capture which cell was last edited.
  // We pass this wrapped version to EditorTable so we intercept without
  // touching EditorTable.tsx.
  const applyOptimisticTargetEditWithCapture = useCallback(
    (cellId: string, patch: { value: string; valueHtml?: string }) => {
      if (patch.value) {
        lastOptimisticEditRef.current = { cellId }
      }
      applyOptimisticTargetEdit(cellId, patch)
    },
    [applyOptimisticTargetEdit],
  )

  const getPendingTargetEventId = useCallback((cellId: string) => {
    return pendingTargetCommitHeadsRef.current.get(cellId)?.eventId ?? null
  }, [])

  const resolveTargetCommitParentId = useCallback((cell: Pick<CellData, "id" | "targetEventId" | "sourceEventId">) => {
    return (
      pendingTargetCommitHeadsRef.current.get(cell.id)?.eventId ??
      pendingCompletionEventIdRef.current.get(cell.id) ??
      cell.targetEventId ??
      cell.sourceEventId ??
      null
    )
  }, [])

  const rememberPendingTargetCommit = useCallback((cellId: string, eventId: string, parentId: string | null) => {
    pendingTargetCommitHeadsRef.current.set(cellId, { eventId, parentId })
  }, [])

  useEffect(() => {
    if (pendingTargetCommitHeadsRef.current.size === 0) return
    for (const summary of cellSummaries) {
      const pending = pendingTargetCommitHeadsRef.current.get(summary.id)
      if (!pending) continue
      const projectedHead = summary.targetEventId ?? null
      if (projectedHead === pending.eventId) {
        pendingTargetCommitHeadsRef.current.delete(summary.id)
        if (pendingCompletionEventIdRef.current.get(summary.id) === pending.eventId) {
          pendingCompletionEventIdRef.current.delete(summary.id)
        }
      } else if (projectedHead && projectedHead !== pending.parentId) {
        pendingTargetCommitHeadsRef.current.delete(summary.id)
        if (pendingCompletionEventIdRef.current.get(summary.id) === pending.eventId) {
          pendingCompletionEventIdRef.current.delete(summary.id)
        }
      }
    }
  }, [cellSummaries])
  // Phase 5 / AD-9 — Phase 3a-final wiring. Fetch the set of cell ids
  // whose source has advanced since the translator's last commit, so the
  // editor table can decorate stale rows with the AlertTriangle badge.
  // One fetch per (projectId, fileId) — flattened to a boolean per row
  // inside EditorTable.
  // FRO-477 (§6) — upstreamStaleCellIds surfaces inherited (ancestor-chain)
  // staleness alongside the existing direct staleCellIds; both flatten to
  // per-row booleans inside EditorTable the same way.
  const { staleCellIds, upstreamStaleCellIds, revalidate: revalidateStaleSource, syncNow: syncStaleSourceNow } = useStaleSourceCells({
    projectId: project?.id ?? null,
    fileId: activeFileId,
    getToken: getTokenForFile,
    enabled: Boolean(project?.id && activeFileId && frontierSession?.jwt),
  })
  // FRO-479: the WS connect effect's onMessage closure is created once, before
  // staleness state settles — route link.upstream-changed frames through a ref
  // so the handler always reaches the latest revalidate (which piggybacks the
  // fire-and-forget POST /link/sync, single-flighted server-side).
  const staleSourceRevalidateRef = useRef<() => void>(() => {})
  staleSourceRevalidateRef.current = revalidateStaleSource
  // QA-BUG-2: awaitable sync — the push handler awaits this THEN revalidates
  // cells too, so the mirrored source TEXT updates live (not just the badge).
  const syncStaleSourceNowRef = useRef<() => Promise<void>>(async () => {})
  syncStaleSourceNowRef.current = syncStaleSourceNow
  const revalidateCellsRef = useRef<() => void>(() => {})
  revalidateCellsRef.current = revalidateCells

  // Audio lens: TTS settings (engine, voice library, cast) hydrated from IDB
  // and overlaid onto the project so generation uses the real engine/key/cast.
  const tts = useProjectTts(
    project?.id ?? null,
    project?.ttsSettings,
    cellSummaries,
    (profiles) => { void patchSettings({ ttsSettings: profiles }) },
  )
  const audioProject = useMemo(
    () => (project ? { ...project, ttsSettings: tts.settings } : null),
    [project, tts.settings],
  )
  const audioLens = useMemo<AudioLensContext | null>(
    () =>
      lens === "audio" && audioProject
        ? {
            voices: tts.voices,
            settings: tts.settings,
            defaultVoiceId: tts.defaultVoiceId,
            project: audioProject,
            projectId: audioProject.id,
            session: frontierSession ?? null,
            username: currentUsername,
            onAssignCast: (cellId, voiceId) => tts.assignCells([cellId], voiceId),
            onAfterGenerate: refresh,
            // Play just this one line through the shared play-queue: hand it a
            // single-cell snapshot so it doesn't walk on to the next line.
            // Prefer the audio-enriched cell from the table — the raw `cells`
            // row never carries selectedGeneratedVoiceAudioId/attachments, so
            // pickPlayableAudio would find nothing and play would go silently
            // IDLE right after a generate.
            onPlayCell: (cellId, enrichedCell) => {
              if (!frontierSession?.jwt) return
              const cell = enrichedCell ?? cellStore.getCellView(cellId)
              if (!cell) return
              startQueue(
                { cells: [cell], projectId: audioProject.id, session: frontierSession },
                0,
              )
            },
            // Turn this line's take into a reusable Cast character.
            onMakeCharacterFromCell: (cellId) => {
              setMakeCharacterSeedCellId(cellId)
              setMakeCharacterOpen(true)
            },
          }
        : null,
    [
      lens, audioProject, tts.voices, tts.settings, tts.defaultVoiceId, tts.assignCells,
      frontierSession, currentUsername, cellStore, refresh,
    ],
  )

  const { hasAny: hasUnfinished, findNext: findNextUnfinished } = useNextUnfinished(cellSummaries, validationCount)
  const handleJumpNextUnfinished = useCallback(() => {
    const currentIndex = editorRef.current?.getCurrentIndex?.() ?? 0
    const next = findNextUnfinished(currentIndex)
    if (next >= 0) editorRef.current?.focusCellEditorIndex(next)
  }, [findNextUnfinished])
  const activeFile = activeFileId ? project?.files.find((f) => f.id === activeFileId) : null
  const activeSourceLanguage = activeFile?.sourceLanguage || project?.sourceLanguage
  // The DEFAULT (`''`) lane's target language — the PROJECT default only. Used to
  // label the default-lane switch option, which must always name the project
  // default regardless of which lane is active. AQU-583: the per-file target is
  // NOT consulted — it would otherwise both shadow a later Settings change and
  // surface a stamped language when the project has none set.
  const activeTargetLanguage = project?.targetLanguage
  // AQU-602: the target language of the ACTIVE lane. A non-default lane's tag IS
  // its target language, so switching lanes switches what the editor
  // reads/writes/translates into (source stays shared). The completion path was
  // already lane-aware; this routes the editor project + file metadata through
  // the same rule so the target language actually changes on lane switch.
  const activeLaneTargetLanguage = resolveActiveTargetLanguage(
    activeLane,
    activeFile?.targetLanguage,
    project?.targetLanguage,
  )

  // AQU-538 (slice 2): active target lane. `''` = default lane. The registry
  // arrives on the settings-overlaid project record (useProject overlaySettings).
  const targetLanes = useMemo<string[]>(() => project?.targetLanes ?? [], [project])
  const availableLanes = useMemo(() => ["", ...targetLanes], [targetLanes])
  // If the active lane is no longer offered (removed from settings), fall back
  // to the default lane so the editor never points at a nonexistent lane.
  useEffect(() => {
    if (activeLane && !availableLanes.includes(activeLane)) setActiveLaneState("")
  }, [activeLane, availableLanes])
  const setActiveLane = useCallback(
    (lane: string) => {
      setActiveLaneState(lane)
      if (projectId) writePersistedActiveLane(projectId, lane)
    },
    [projectId],
  )
  // AQU-538 deep link: `/project/:id?lane=<tag>` — PM surfaces link into the
  // editor at the lane they were viewing. Read the param ONCE per project (after
  // the lane registry loads so an unknown tag can be told apart from a
  // not-yet-loaded one); a valid tag selects that lane, an unknown tag falls
  // back to the default. One-shot: it never fights the user's later switches.
  const deepLinkLaneAppliedRef = useRef(false)
  useEffect(() => {
    deepLinkLaneAppliedRef.current = false
  }, [projectId])
  useEffect(() => {
    if (deepLinkLaneAppliedRef.current || !projectId) return
    const param = searchParams.get("lane")
    if (!param) {
      deepLinkLaneAppliedRef.current = true
      return
    }
    // Defer until the project (and thus its lane registry) has loaded, so an
    // unknown tag isn't mistaken for one whose registry hasn't arrived yet.
    if (!project) return
    const resolved = resolveDeepLinkLane(param, availableLanes)
    deepLinkLaneAppliedRef.current = true
    if (resolved !== null) setActiveLane(resolved)
  }, [projectId, project, searchParams, availableLanes, setActiveLane])
  const editorProject = useMemo<ProjectRecord | null>(() => {
    if (!project) return null
    const sourceLanguage = activeSourceLanguage ?? project.sourceLanguage
    const targetLanguage = activeLaneTargetLanguage ?? project.targetLanguage
    if (sourceLanguage === project.sourceLanguage && targetLanguage === project.targetLanguage) {
      return project
    }
    return { ...project, sourceLanguage, targetLanguage }
  }, [activeSourceLanguage, activeLaneTargetLanguage, project])
  const fileMeta = useFileMeta(activeFileId, activeSourceLanguage, activeLaneTargetLanguage, {
    sourceTextDirection: activeFile?.sourceTextDirection,
    targetTextDirection: activeFile?.targetTextDirection,
  })
  const activeFileDirectionSummary = useMemo(() => {
    function* sourceValues() {
      for (const summary of cellSummaries) yield summary.originalHtml ?? summary.original
    }
    function* targetValues() {
      for (const summary of cellSummaries) yield summary.translatedHtml ?? summary.translated
    }
    return {
      source: summarizeTextDirections(sourceValues()),
      target: summarizeTextDirections(targetValues()),
    }
  }, [cellSummaries])
  const [cellLabelsEnabled, setCellLabelsEnabled] = useCellLabelsPreference(projectId!)
  const [footnoteViewMode, setFootnoteViewMode] = useFootnotesPreference(projectId!)
  const [visibleFootnotes, setVisibleFootnotes] = useState<VisibleFootnoteEntry[]>([])
  const visibleFootnotesKeyRef = useRef("")
  // FRO-251: per-file, per-side font sizes — adjusted from the View settings
  // (eye) menu, rendered by EditorTable.
  const fontSizes = useFileFontSizes(activeFileId)

  const isSubtitleFile = activeFile?.type === "vtt" || activeFile?.type === "srt"

  const workspaceBreadcrumb = useMemo(() => ({
    surfaceLabel:
      centerSurface === "editor" ? "Editor" : deriveNavTitle(location.pathname),
  }), [centerSurface, location.pathname])

  const handleVisibleFootnotesChange = useCallback((entries: VisibleFootnoteEntry[]) => {
    const key = entries
      .map((entry) => [
        entry.cellId,
        entry.activeFootnoteIndex ?? "",
        entry.sourceFootnotes.map((fn) => `${fn.index}:${fn.text}`).join(","),
        entry.targetFootnotes.map((fn) => `${fn.index}:${fn.text}`).join(","),
      ].join(":"))
      .join("|")
    if (visibleFootnotesKeyRef.current === key) return
    visibleFootnotesKeyRef.current = key
    setVisibleFootnotes(entries)
  }, [])

  useEffect(() => {
    if (footnoteViewMode === "tray") return
    visibleFootnotesKeyRef.current = ""
    setVisibleFootnotes([])
  }, [footnoteViewMode])

  // Diarization (M3): "Diarize" a time-ordered media file → replace its media
  // segments with one per detected speaker turn + create "Speaker N" cast.
  const [diarizePhase, setDiarizePhase] = useState<DiarizationPhase | null>(null)
  const [diarizeError, setDiarizeError] = useState<string | null>(null)
  const diarizeBusy = diarizePhase != null && diarizePhase !== "done" && diarizePhase !== "failed"
  const canDiarize =
    !!activeFile && fileOrderedBy(activeFile) === "time" && cellSummaries.some((c) => c.medium === "media")
  const handleDiarize = useCallback(async () => {
    if (!project?.id || !activeFileId) return
    setDiarizeError(null)
    try {
      const cells = cellStore.getAllCellViews()
      await runDiarization({
        projectId: project.id,
        fileId: activeFileId,
        author: currentUsername,
        cells,
        getToken: getTokenForFile,
        ttsSettings: tts.settings,
        saveTts: tts.saveTts,
        onPhase: (p) => setDiarizePhase(p),
      })
      await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
      revalidateCells()
      setDiarizePhase("done")
    } catch (e) {
      setDiarizePhase("failed")
      setDiarizeError(e instanceof Error ? e.message : String(e))
    }
  }, [project?.id, activeFileId, currentUsername, cellStore, getTokenForFile, getTokenForProjectFile, tts.settings, tts.saveTts, revalidateCells])

  // Media-lens empty state: attach a clip to the ACTIVE file by upload or
  // direct URL. The Import dialog can't do this — it always creates a new
  // time-ordered file. Errors propagate to TimelineAddMedia, which renders them.
  const handleAttachMediaFile = useCallback(async (file: File) => {
    if (!project?.id || !activeFileId) return
    await attachMediaFileToTimeline(file, {
      projectId: project.id,
      fileId: activeFileId,
      author: currentUsername,
      getToken: getTokenForFile,
    })
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    revalidateCells()
  }, [project?.id, activeFileId, currentUsername, getTokenForFile, getTokenForProjectFile, revalidateCells])

  const handleAttachMediaUrl = useCallback(async (url: string) => {
    if (!project?.id || !activeFileId) return
    await attachMediaUrlToTimeline(url, {
      projectId: project.id,
      fileId: activeFileId,
      author: currentUsername,
      getToken: getTokenForFile,
    })
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    revalidateCells()
  }, [project?.id, activeFileId, currentUsername, getTokenForFile, getTokenForProjectFile, revalidateCells])

  // Timeline editor: move/stretch a clip → cell.retime (timing on both sides).
  const handleRetime = useCallback(
    async (cellId: string, startSec: number, endSec: number) => {
      if (!project?.id || !activeFileId) return
      await emitCellRetime({
        projectId: project.id,
        fileId: activeFileId,
        cellId,
        startMs: Math.round(startSec * 1000),
        endMs: Math.round(endSec * 1000),
        author: currentUsername,
      })
      await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
      revalidateCells()
    },
    [project?.id, activeFileId, currentUsername, getTokenForProjectFile, revalidateCells],
  )

  // Timeline editor detail pane: commit a target edit (same path as the table).
  const handleTimelineCommitTarget = useCallback(
    async (cellId: string, value: string) => {
      if (!project?.id) return
      const cell = cellStore.getCellView(cellId)
      if (!cell) return
      applyOptimisticTargetEdit(cellId, { value })
      const parentId = resolveTargetCommitParentId(cell)
      const eventId = await emitTargetCellCommit({
        projectId: project.id,
        fileId: cell.fileId,
        cellId,
        parentId,
        sourceEventId: cell.sourceEventId ?? null,
        value,
        author: currentUsername,
        targetLang: activeLane, // AQU-538: '' omitted on the wire by the emit
      })
      rememberPendingTargetCommit(cellId, eventId, parentId)
      await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
      await refreshOutboxPending()
      revalidateCell(cellId)
    },
    [
      project?.id,
      cellStore,
      applyOptimisticTargetEdit,
      currentUsername,
      activeLane,
      resolveTargetCommitParentId,
      rememberPendingTargetCommit,
      getTokenForProjectFile,
      refreshOutboxPending,
      revalidateCell,
    ],
  )

  // Timeline editor: set/clear the file's core video URL (preview master clock).
  // coreMediaUrl lives on the file row, so refresh the project (not just cells).
  const handleLinkVideo = useCallback(
    async (url: string | null) => {
      if (!project?.id || !activeFileId) return
      await emitFileVideoSet({
        projectId: project.id,
        fileId: activeFileId,
        coreMediaUrl: url,
        author: currentUsername,
      })
      await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
      refresh()
    },
    [project?.id, activeFileId, currentUsername, getTokenForProjectFile, refresh],
  )

  const [videoDialogOpen, setVideoDialogOpen] = useState(false)
  const [currentVideoTime, setCurrentVideoTime] = useState(0)
  const videoPlayerRef = useRef<VideoPlayerHandle>(null)
  // Phase 2c-gamma: video attachments lived on Y.Doc meta. Disabled here so
  // the editor still renders for subtitle files; the attach/play workflow
  // comes back via the event grammar in v1.x.
  const videoAttachment: { videoStartOffset?: number; videoUrl?: string } = {}
  const videoSrc: string | null = null
  const blobUnavailable = false
  const saveVideo: (..._: unknown[]) => void = () => {}

  // Live cues for the VideoPlayer's overlay (bypasses iframe CC). We drive
  // rendering from cell data directly so edits appear immediately without a
  // VTT blob round-trip.
  const videoCues = useMemo(() => {
    if (!isSubtitleFile || !videoSrc || cellSummaries.length === 0) return []
    return readAtVersion(cellStoreVersion, () => extractCuesFromCells(cellStore.getAllCellViews()))
  }, [cellStore, cellStoreVersion, cellSummaries.length, isSubtitleFile, videoSrc])

  const videoStartOffset = videoAttachment.videoStartOffset ?? 0

  // Active cue is in cue-space (not raw video time). Adjust by offset.
  const cueTime = currentVideoTime - videoStartOffset
  const activeCueIndex = useMemo(() => {
    if (!isSubtitleFile) return -1
    for (let i = 0; i < cellSummaries.length; i++) {
      const range = parseTimestampRange(cellSummaries[i].context)
      if (!range) continue
      if (cueTime >= range.start && cueTime <= range.end) {
        return i
      }
    }
    return -1
  }, [cellSummaries, cueTime, isSubtitleFile])

  useEffect(() => {
    if (activeCueIndex < 0) return
    const timer = setTimeout(() => {
      editorRef.current?.scrollToCellIndex(activeCueIndex)
    }, 500)
    return () => clearTimeout(timer)
  }, [activeCueIndex])

  const handleCueSeek = useCallback((cellId: string) => {
    const cell = cellStore.getCellView(cellId)
    if (!cell) return
    const range = parseTimestampRange(cell.context)
    if (!range) return
    // Seek in raw video time = cue-space start + offset
    videoPlayerRef.current?.seekTo(range.start + videoStartOffset)
    videoPlayerRef.current?.play().catch(() => { /* autoplay blocked */ })
  }, [cellStore])

  const {
    buildIndex,
    rebuild: rebuildSearchIndex,
    search: runSearch,
    searchParallelPassages: runSearchPassages,
    clear: clearSearchResults,
    results: searchResults,
    loading: searchLoading,
    ready: searchReady,
  } = useWorkspaceSearch({ projectId: project?.id ?? null, getToken: getTokenForFile, files: project?.files || [] })

  // Merge: AD-14 (this branch) retired the composite-health `penalties` path.
  // Comments handlers take main's Phase 2c-gamma rip — threads/messages lived
  // on Y.Doc maps and the v1.x event grammar isn't in this build, so these are
  // no-ops and the drawer renders empty.
  // Org-level rules: fetch from org settings and merge with project rules.
  const {
    orgRules,
    promotionRequests,
    canEdit: canEditOrgSettings,
    canRequestPromotion,
    requestPromotion,
    patch: patchOrgSettings,
    version: orgSettingsVersion,
    canExport: canExportByOrgPolicy,
    hasFetched: orgSettingsFetched,
    // AQU-496: whether below-lead members may self-assign work.
    allowSelfAssignment,
  } = useOrgSettings(
    project?.orgId ?? activeOrg?.id,
    projectOrg?.role?.level ?? null,
    // FRO-253 WARN fix: compare the project-resolved role (AD-12 max-wins), not
    // the raw org role. A user with org VIEWER + direct project MAINTAINER grant
    // must pass a floor of MAINTAINER. syncRole.level is the max-wins result
    // written by the sync-token onRole callback above.
    project?.syncRole?.level ?? null,
  )

  // FRO-194: also destructure rule CRUD for RulesSurface (patchSettings is the
  // sync function; it matches the PatchSharedFn signature from useProjectSettings).
  const { rules, userRules, builtinRules, addRule, updateRule, deleteRule, setBuiltinOverride } = useRules(
    project ?? null,
    refresh,
    patchSettings as Parameters<typeof useRules>[2],
    orgRules,
  )
  const {
    comments: allProjectComments,
    addComment: addCommentEvent,
    resolveThread: resolveCommentThread,
    refresh: refreshComments,
  } = useComments({
    projectId: project?.id ?? null,
    getToken: getTokenForFile,
    author: currentUsername,
  })

  // AQU-599: per-cell "has comment" indicator. useHealth also exposes a
  // cellOpenCommentCount, but it derives from cell.threads which useCells
  // leaves empty in Phase 2a — so it never lit up from live data. Derive the
  // real per-cell count from the live comments feed instead: count open
  // (unresolved, non-deleted) root threads (replies don't open a thread) keyed
  // by cellId. This feeds EditorTable's existing ring + rail-dot affordance so
  // cells carrying comments are discoverable without opening each one.
  const liveCellOpenCommentCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of allProjectComments) {
      if (c.scopeKind !== "cell" || !c.cellId) continue
      if (c.parentCommentId) continue
      if (c.deletedAt !== null) continue
      if (c.resolved) continue
      map.set(c.cellId, (map.get(c.cellId) ?? 0) + 1)
    }
    return map
  }, [allProjectComments])

  const addThread = useCallback(async (cellId: string, text: string) => {
    if (!project?.id || !activeFileId) return
    await addCommentEvent({
      scope: { kind: "cell", fileId: activeFileId, cellId },
      body: text,
    })
  }, [project?.id, activeFileId, addCommentEvent])

  const addMessage = useCallback(async (cellId: string, threadId: string, text: string) => {
    if (!project?.id || !activeFileId) return
    await addCommentEvent({
      scope: { kind: "cell", fileId: activeFileId, cellId },
      body: text,
      parentCommentId: threadId,
    })
  }, [project?.id, activeFileId, addCommentEvent])

  const resolveThread = useCallback(async (cellId: string, threadId: string, msg?: string) => {
    if (!project?.id) return
    // FRO-252 fix: derive the fileId from the thread's own record, not from
    // activeFileId. Using activeFileId caused two bugs:
    //   (a) Resolving with a reply from the /comments shell (no file open) dropped
    //       the reply silently because activeFileId was null.
    //   (b) The reply was scoped to the CURRENTLY OPEN file even when the thread
    //       belonged to a different file.
    // allProjectComments is from the same useComments instance, so the lookup
    // is always consistent with the resolve event's target.
    const threadRecord = allProjectComments.find((c) => c.commentId === threadId)
    const threadFileId = threadRecord?.fileId ?? null

    if (msg?.trim()) {
      // Prefer the thread's own fileId; fall back to activeFileId as a last
      // resort (e.g. the comment was created against the current file before
      // the server confirmed its fileId into allProjectComments).
      const replyFileId = threadFileId ?? activeFileId
      if (replyFileId) {
        await addCommentEvent({
          scope: { kind: "cell", fileId: replyFileId, cellId },
          body: msg.trim(),
          parentCommentId: threadId,
        })
      } else {
        // No fileId available — add as a project-scoped reply so the message
        // is not silently lost.
        await addCommentEvent({
          scope: { kind: "project" },
          body: msg.trim(),
          parentCommentId: threadId,
        })
      }
    }
    await resolveCommentThread(threadId, true)
  }, [project?.id, activeFileId, allProjectComments, addCommentEvent, resolveCommentThread])

  const reopenThread = useCallback(async (_cellId: string, threadId: string) => {
    await resolveCommentThread(threadId, false)
  }, [resolveCommentThread])
  const commentsCell = commentsCellId ? getActiveCell(commentsCellId) : null
  const historyCell = historyCellId ? getActiveCell(historyCellId) : null

  // Debounced corpus for the heavy whole-project derivations only (glosser,
  // interlinear alignment model, few-shot search index). During "complete all"
  // every committed cell mutates the active-file summaries, which would otherwise rebuild
  // all three ~twice per cell — a GB/s allocation storm that OOM-crashes the tab
  // (see useDebouncedValue). These derivations feed BT/interlinear display +
  // example retrieval, none of which must be live mid-batch, so coalescing the
  // rebuild to once the batch pauses removes the storm. Health, progress, and
  // the edit/commit path keep live selectors.
  const corpusCells = useDebouncedValue(cellSummaries, 600)

  // FRO-191 (orchestrator glue): existing-cell refs for the eBible "into target
  // column" import mode. CellData.group carries the canonical ref.
  const importSourceCells = useMemo(() => cellSummaries.map((c) => ({
    cellId: c.id,
    fileId: c.fileId,
    targetEventId: c.targetEventId,
    sourceEventId: c.sourceEventId,
    translated: c.translated ?? "",
    canonicalRef: c.group,
  })), [cellSummaries])

  // File-scoped target import: the open file's cells in display order, with
  // source text so the review screen can show alignment.
  const fileTargetCells = useMemo(() => cellSummaries.map((c) => ({
    cellId: c.id,
    fileId: c.fileId,
    targetEventId: c.targetEventId,
    sourceEventId: c.sourceEventId,
    translated: c.translated ?? "",
    canonicalRef: c.group,
    original: c.original,
  })), [cellSummaries])

  // AD-13 branching-search adapters — single-cell completion's few-shot
  // retrieval (`branchingSearch`) and the batch completion's passage
  // retrieval (`branchingSearchPassages`). Replace the in-memory dual-
  // index calls with server fetches so the AI copilot uses the same
  // retrieval primitive every other AD-13 consumer will (AD-14 decay
  // endorsement included).
  //
  // A failed request yields no examples rather than falling back to an
  // unreviewed local corpus. The draft may proceed zero-shot, but the trust
  // boundary around approved retrieval remains intact.
  const branchingSearch = useCallback(
    async (
      query: string,
      limit?: number,
      excludeId?: string,
    ): Promise<ScoredPair[]> => {
      const pid = project?.id
      const fid = activeFileId
      if (!pid || !fid) return []
      const jwt = await getTokenForFile(fid)
      if (!jwt) return []
      try {
        const res = await fetchBranchingSearch({
          projectId: pid,
          query,
          jwt,
          topK: limit,
          validatedOnly: true,
          excludeCellId: excludeId,
        })
        return res.results.map((r) => ({
          cellId: r.cellId,
          fileId: "",
          source: r.sourceText,
          target: r.targetText,
          score: 1,
          matchedTokens: res.provenance[r.cellId] ?? [],
          coverageWeight: r.queryCoverage,
        }))
      } catch (err) {
        console.warn("[ProjectWorkspace] branching-search fetch failed:", err)
        return []
      }
    },
    [project?.id, activeFileId, getTokenForFile],
  )

  const branchingSearchPassages = useCallback(
    async (
      query: string,
      hits?: number,
      radius?: number,
    ): Promise<PassageHit[]> => {
      const pid = project?.id
      const fid = activeFileId
      if (!pid || !fid) return Promise.resolve([])
      const jwt = await getTokenForFile(fid)
      if (!jwt) return Promise.resolve([])
      try {
        const res = await fetchBranchingSearchPassages({
          projectId: pid,
          query,
          jwt,
          topK: hits,
          radius,
          validatedOnly: true,
        })
        // Map server `Passage` → existing `PassageHit` shape. Drops
        // `hitCellId` (derivable from cells.find(c => c.hit)) and
        // `anchorCellId` (unused by the prompt builder).
        return res.passages.map((p) => ({
          fileId: p.fileId,
          cells: p.cells.map((c) => ({
            cellId: c.cellId,
            source: c.sourceText,
            target: c.targetText,
            hit: c.hit,
          })),
        }))
      } catch (err) {
        console.warn("[ProjectWorkspace] branching-search-passages fetch failed:", err)
        return []
      }
    },
    [project?.id, activeFileId, getTokenForFile],
  )

  const commitCompletedCell = useCallback(async (cell: CellData, text: string, author: string, provenance: AiDraftProvenance) => {
    if (!project?.id) return
    // FRO-365: defense-in-depth — the selection-island Translate button and
    // the header "Run AI completions"/"Complete all" actions are already
    // hidden below the contributor floor (SelectionBar.tsx, registry.ts), and
    // the server 403s the resulting target.cell.commit regardless. This guard
    // stops a below-floor caller from getting even a local optimistic echo
    // (applyOptimisticTargetEdit) of a write the server will refuse, matching
    // the same mirror-check used by handleEditorCommit/commitTrayFootnoteText.
    if (!canPerform("target.cell.commit", project.syncRole?.level ?? null)) return
    // Optimistic local patch BEFORE the outbox enqueue. Mirrors what
    // handleEditorCommit in EditorTable does for hand-typed edits, and
    // collapses the race window where `cells.translated` would otherwise
    // stay at the old value until `revalidateCells` fetched from the
    // server. Without this, TipTap's `initialPlain` is briefly stale and
    // any TipTap-side commit fired during that window (DOM reflow when
    // the loading overlay vanishes, a virtualized-list remount, a focus
    // bounce) chains a *revert* event with the pre-gen text onto the
    // gen — producing the "two events at 5:08, second one identical to
    // 2:28" history pattern.
    applyOptimisticTargetEdit(cell.id, { value: text, aiDrafted: true })
    // RACE-3/QW-2: use the pending event id for this cell (last AI-completion
    // commit we enqueued) as parentId, falling back to the projection value.
    // This prevents a second rapid completion commit from becoming a sibling
    // of the first (which the server dead-letters) when the read-back hasn't
    // landed yet.
    const parentId = resolveTargetCommitParentId(cell)
    const eventId = await emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      parentId,
      sourceEventId: cell.sourceEventId ?? null,
      value: text,
      author,
      targetLang: activeLane, // AQU-538: '' omitted on the wire by the emit
      // FRO-292: tag AI-generated commits so the server projection can
      // track ai_drafted on the cell row. A human edit (no aiSuggestion)
      // will clear it on the next commit.
      aiSuggestion: true,
      aiDraft: provenance,
    })
    pendingCompletionEventIdRef.current.set(cell.id, eventId)
    rememberPendingTargetCommit(cell.id, eventId, parentId)
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    // Targeted: we just changed exactly one cell. Pull only that row's stats
    // and cell data back (its authoritative event_id becomes the next
    // commit's parent) instead of re-fetching stats for all ~30k cells in
    // the file. The optimistic shadow keeps the value visible until this
    // confirms; the WS event.applied also pokes the same cell (coalesced).
    revalidateCellStats(cell.id)
    revalidateCell(cell.id)
  }, [project?.id, project?.syncRole?.level, applyOptimisticTargetEdit, activeLane, resolveTargetCommitParentId, rememberPendingTargetCommit, getTokenForProjectFile, refreshOutboxPending, revalidateCellStats, revalidateCell])

  /**
   * AD-2 sibling promotion: emit a new target-cell commit whose parentId is
   * the current chain head (historyCell.targetEventId). This makes the
   * promoted text the new current value while the prior head becomes a stale
   * sibling — exactly the first-child-of-parent win rule applied in reverse.
   */
  const handlePromoteToCurrentCell = useCallback(async (entry: import("@/lib/parsers/types").CellHistoryEntry) => {
    if (!project?.id || !historyCellId) return
    const cell = getActiveCell(historyCellId)
    if (!cell) return
    applyOptimisticTargetEdit(cell.id, { value: entry.value })
    const parentId = resolveTargetCommitParentId(cell)
    const eventId = await emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      // parentId must be the current chain head so AD-2 makes this the winner.
      parentId,
      sourceEventId: cell.sourceEventId ?? null,
      value: entry.value,
      author: currentUsername,
      targetLang: activeLane, // AQU-538: '' omitted on the wire by the emit
    })
    rememberPendingTargetCommit(cell.id, eventId, parentId)
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    // Single-cell promotion — targeted refetch (see commitCompletedCell).
    revalidateCellStats(cell.id)
    revalidateCell(cell.id)
  }, [project?.id, historyCellId, getActiveCell, applyOptimisticTargetEdit, activeLane, resolveTargetCommitParentId, rememberPendingTargetCommit, getTokenForProjectFile, currentUsername, refreshOutboxPending, revalidateCellStats, revalidateCell])

  const { completeSingle, completeBatch, isConfigured, isAvailable: isCompletionAvailable, completing, examples, errors, previews } = useCompletion(
    // AQU-538/AQU-602: when a non-default lane is active, its tag IS the target
    // language for few-shot/completion; default lane falls back to the file's
    // (then project's) targetLanguage exactly as before. Shares the same
    // lane-aware derivation as the editor project + file metadata.
    project?.completionSettings, project?.sourceLanguage || "", activeLaneTargetLanguage || "", branchingSearch, branchingSearchPassages, frontierSession, commitCompletedCell, rules, getActiveCells, project?.translationBrief?.l1Summary ?? undefined,
    project?.draftContext ?? DEFAULT_DRAFT_CONTEXT,
  )

  // AQU-620: adapter so the editor's per-cell AI action can request a plain
  // draft (`onCompleteSingle(cell)`) or an explicit regenerate
  // (`onCompleteSingle(cell, { regenerate: true })`) — the latter maps to the
  // hook's third argument so a second iteration samples at a higher temperature.
  const handleCompleteSingle = useCallback(
    (cell: CellData, opts?: { regenerate?: boolean }) => { void completeSingle(cell, undefined, opts) },
    [completeSingle],
  )

  // Translation agent (chat dock Agent mode): live cell lookup for proposal
  // lint + chain heads, and the post-apply flush/revalidate sequence — the
  // same steps commitCompletedCell runs after its own enqueue.
  const resolveCellById = useCallback(
    (cellId: string) => getActiveCell(cellId) ?? undefined,
    [getActiveCell],
  )
  const handleAgentApplied = useCallback(
    async (_eventIds: string[], cellIds: string[]) => {
      await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
      await refreshOutboxPending()
      // Targeted: the agent only touched cellIds — pull just those rows'
      // stats instead of the whole file's (see commitCompletedCell).
      for (const cellId of cellIds) {
        revalidateCellStats(cellId)
        revalidateCell(cellId)
      }
    },
    [getTokenForProjectFile, refreshOutboxPending, revalidateCellStats, revalidateCell],
  )

  // ── Back-translation: LLM generation on demand ─────────────────────────────
  //
  // Generation strategy:
  //  1. The BT of record is LLM-generated, and ONLY when the user asks for it
  //     (the Generate/Refresh buttons in the BT tab). Nothing auto-runs on commit.
  //  2. The statistical Markov glosser survives as a read-only, on-demand
  //     reference (collapsed section in the BT tab) — computed locally, never
  //     persisted.
  //
  // Persistence:
  //  - On generate: emit `cell.backtranslation.set` via outbox (non-chain-mutating).
  //  - Local in-memory cache (`backtranslationCache`) so UI is instant.
  //  - localStorage fallback so results survive page reload before server round-trip.
  //
  const [backtranslationCache, setBacktranslationCache] = useState<Map<string, string>>(new Map())
  const [backtranslatingState, setBacktranslatingState] = useState<Set<string>>(new Set())
  const [backtranslationErrorsState, setBacktranslationErrorsState] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (typeof window === "undefined") return
    ;(window as typeof window & { __aquillaBtGenerationInFlight?: number }).__aquillaBtGenerationInFlight = backtranslatingState.size
    return () => {
      delete (window as typeof window & { __aquillaBtGenerationInFlight?: number }).__aquillaBtGenerationInFlight
    }
  }, [backtranslatingState.size])

  // Hydrate persisted BTs on file/project load from the cell-backtranslations-read route.
  // Compares each BT's targetEventId against the cell's eventId to detect staleness.
  // Falls back gracefully to local generation on any error.
  useEffect(() => {
    if (!project?.id || !activeFileId) return
    let cancelled = false
    void (async () => {
      try {
        const jwt = await getTokenForFile(activeFileId)
        if (!jwt || cancelled) return
        const { syncWorkerHttpOrigin } = await import("@/lib/sync/sync-worker-url")
        const res = await fetch(
          `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(activeFileId)}/backtranslations`,
          { headers: { Authorization: `Bearer ${jwt}` } },
        )
        if (!res.ok || cancelled) return
        const data = (await res.json()) as {
          backtranslations: Array<{
            cellId: string
            targetEventId: string
            btText: string
            btHtml: string | null
            polished: boolean
            author: string
            eventId: string
            createdAt: number
          }>
        }
        if (cancelled) return
        setBacktranslationCache((prev) => {
          const next = new Map(prev)
          for (const bt of data.backtranslations) {
            // Only hydrate if not already in cache (local edits take precedence).
            if (!next.has(bt.cellId)) {
              next.set(bt.cellId, bt.btText)
            }
          }
          return next
        })
      } catch (err) {
        // Non-fatal: fall back to local generation / localStorage.
        console.warn("[bt-hydrate] failed to fetch persisted BTs:", err)
      }
    })()
    return () => { cancelled = true }
  }, [project?.id, activeFileId, getTokenForFile])

  // Same gate as the AI-completion sparkle: a signed-in Frontier session or a
  // custom endpoint+model (project settings or per-device override) counts as
  // configured — BT generation no longer requires project-level customization.
  const isBacktranslationConfigured = isConfigured

  // Build the glosser lazily from translated pairs. This used to run on every
  // workspace open after corpusCells settled, allocating a large temporary
  // target-ngram x source-ngram graph even when the user only wanted to scroll.
  // Keep it cached for feature paths that actually need BT generation.
  const getGlosser = useCallback((): Glosser => {
    const terminology = project?.terminology
    const cached = glosserCacheRef.current
    if (
      cached &&
      cached.corpusCells === corpusCells &&
      cached.backtranslationCache === backtranslationCache &&
      cached.terminology === terminology
    ) {
      return cached.glosser
    }

    const pairs = corpusCells
      .filter((c) => c.original?.trim() && c.translated?.trim())
      .map((c) => ({ source: c.original!, target: c.translated }))
    // High-weight seeds from previous user-corrected BTs stored in the cache.
    // Corrected BTs (saved via onSaveBacktranslation) are re-fed as seeds so
    // future glosses reflect the reviewer's intent.
    const seeds: BtSeed[] = []
    const corpusByCellId = new Map(corpusCells.map((c) => [c.id, c]))
    for (const [cellId, btText] of backtranslationCache) {
      const cell = corpusByCellId.get(cellId)
      if (cell?.translated) {
        seeds.push({ source: btText, target: cell.translated, weight: 3 })
      }
    }
    // Seed from project termbase: active concepts feed preferred/admitted/forbidden
    // renderings into the glosser so terminology constraints propagate to BTs.
    for (const concept of project?.terminology ?? []) {
      if (concept.status !== "active") continue
      for (const rendering of concept.renderings) {
        const weight =
          rendering.status === "preferred" ? 3 :
          rendering.status === "admitted" ? 1 :
          -3 // forbidden
        seeds.push({ source: concept.sourceTerm, target: rendering.rendering, weight })
      }
    }
    const g = buildGlosser(pairs, seeds)
    memMark(`glosser.build(${pairs.length}p)`)
    glosserCacheRef.current = {
      corpusCells,
      backtranslationCache,
      terminology,
      glosser: g,
    }
    return g
  }, [corpusCells, backtranslationCache, project?.terminology])

  // Build the interlinear alignment model lazily. It is only used inside an
  // expanded row's BT tab, so constructing it on workspace open just burns heap
  // before the user asks for that surface.
  const getAlignmentModel = useCallback((): AlignmentModel => {
    const alignmentSeeds = project?.alignmentSeeds
    const cached = alignmentModelCacheRef.current
    if (
      cached &&
      cached.corpusCells === corpusCells &&
      cached.alignmentSeeds === alignmentSeeds
    ) {
      if (typeof window !== "undefined") {
        ;(window as typeof window & { __aquillaAlignmentModelBuilt?: boolean }).__aquillaAlignmentModelBuilt = true
      }
      return cached.model
    }

    const pairs = corpusCells
      .filter((c) => c.original?.trim() && c.translated?.trim())
      .map((c) => ({ source: c.original!, target: c.translated }))
    const m = buildAlignmentModel(pairs, alignmentSeeds ?? [])
    memMark(`alignmentModel.build(${pairs.length}p)`)
    if (typeof window !== "undefined") {
      ;(window as typeof window & { __aquillaAlignmentModelBuilt?: boolean }).__aquillaAlignmentModelBuilt = true
    }
    alignmentModelCacheRef.current = {
      corpusCells,
      alignmentSeeds,
      model: m,
    }
    return m
  }, [corpusCells, project?.alignmentSeeds])

  useEffect(() => {
    if (typeof window === "undefined") return
    ;(window as typeof window & { __aquillaAlignmentModelBuilt?: boolean }).__aquillaAlignmentModelBuilt = false
  }, [activeFileId, project?.id])

  // Persist a confirmed/invalidated alignment as an additive seed via the same
  // project-settings sync path used for terminology.
  const handleAlignmentSeedChange = useCallback(
    (seed: import("@/lib/completion/interlinear").AlignmentSeed) => {
      const existing = project?.alignmentSeeds ?? []
      // De-dupe by (srcToken,tgtToken): the latest weight wins.
      const next = existing.filter(
        (s) => !(s.srcToken === seed.srcToken && s.tgtToken === seed.tgtToken),
      )
      next.push(seed)
      void patchSettings({ alignmentSeeds: next })
    },
    [project?.alignmentSeeds, patchSettings],
  )

  /** Persist a BT text to local cache + localStorage + outbox. */
  const persistBt = useCallback((
    cell: CellData,
    btText: string,
    polished: boolean,
  ) => {
    // The BT pins to the commit it describes. Generation is manual-only, so
    // there is never an in-flight commit here — the projected head is current.
    const pinnedTargetEventId = resolveBtTargetEventId(undefined, cell.targetEventId)

    // 1. In-memory cache
    setBacktranslationCache((prev) => new Map(prev).set(cell.id, btText))

    // 2. localStorage fallback (survives reload before server round-trip)
    try {
      const lsKey = `bt:${project?.id ?? ""}:${cell.id}`
      localStorage.setItem(lsKey, JSON.stringify({
        btText,
        polished,
        targetEventId: pinnedTargetEventId,
        savedAt: Date.now(),
      }))
    } catch { /* ignore quota/private-browsing errors */ }

    // 3. Outbox event
    if (!project?.id || !cell.fileId || !pinnedTargetEventId) {
      console.warn("[bt-persist] missing project/file/targetEventId — skipping outbox emit")
      return
    }
    void emitCellBacktranslationSet({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      btText,
      targetEventId: pinnedTargetEventId,
      polished,
      author: currentUsername,
    }).catch((err) => {
      console.warn("[bt-persist] outbox emit failed:", err)
      // FRO-274: surface enqueue failure so the user knows the BT didn't
      // persist to the server queue. The in-memory + localStorage copies
      // still exist, but they need to reload to re-queue.
      setBtWriteError("Couldn't save the back-translation locally — copy your text and reload.")
    })
  }, [project?.id, currentUsername, setBtWriteError])

  /**
   * Generate the cell's back-translation with the configured LLM. Called by
   * the BT tab's Generate/Refresh buttons — this is the ONLY generation path
   * that persists a BT; nothing runs automatically on commit. The statistical
   * glosser is a separate read-only reference surfaced on demand via
   * `getStatisticalBt` (never persisted).
   */
  const runBacktranslation = useCallback(async (cell: CellData, actionSource?: BacktranslationActionSource) => {
    if (!actionSource) {
      const message = "[bt] generateBacktranslation requires an explicit user action source"
      if (import.meta.env.DEV || import.meta.env.MODE === "test") throw new Error(message)
      console.warn(message)
      return
    }
    if (!cell.translated?.trim() || !isBacktranslationConfigured) return
    const cellId = cell.id
    setBacktranslatingState((prev) => new Set(prev).add(cellId))
    setBacktranslationErrorsState((prev) => { const n = new Map(prev); n.delete(cellId); return n })
    try {
      const btText = await generateBacktranslation({
        // Same precedence as the AI-completion path: project settings when
        // customized, Frontier defaults otherwise. complete() layers the
        // per-device provider override on top.
        settings: project?.completionSettings ?? FALLBACK_COMPLETION_SETTINGS,
        session: frontierSession,
        sourceLanguage: project?.sourceLanguage || "English",
        targetLanguage: project?.targetLanguage || "Unknown",
        targetText: cell.translated,
        examples: [],
        // btseed-glue: seed terminology so the literal BT surfaces the
        // controlled-vocabulary source headwords for the renderings the
        // translator chose. The service derives the relevant hints from
        // the cell's source text; behavior is unchanged when nothing matches.
        concepts: project?.terminology ?? [],
        sourceText: cell.original,
      })
      if (!btText.trim()) throw new Error("The model returned an empty back-translation.")
      persistBt(cell, btText, true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setBacktranslationErrorsState((prev) => new Map(prev).set(cellId, msg))
    } finally {
      setBacktranslatingState((prev) => { const n = new Set(prev); n.delete(cellId); return n })
    }
  }, [isBacktranslationConfigured, project?.completionSettings, project?.sourceLanguage, project?.targetLanguage, project?.terminology, frontierSession, persistBt])

  /**
   * On-demand statistical gloss for the BT tab's collapsed "statistical
   * reference" section. Computed from the project's own translation pairs,
   * never persisted — it's a rough corpus-derived hint, not the BT of record.
   */
  const getStatisticalBt = useCallback((translatedText: string): string => {
    if (!translatedText.trim()) return ""
    const gloss = getGlosser().gloss(translatedText).trim()
    // A gloss that only echoes the translation back is the glosser's
    // no-corpus fallback (unknown tokens pass through) — return "" so the
    // BT tab can say "not enough pairs yet" instead of presenting the
    // translation as its own reading.
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    return norm(gloss) === norm(translatedText) ? "" : gloss
  }, [getGlosser])

  // Add-from-selection: create a DRAFT concept from a source-side selection in
  // the editor and persist it via the same project-settings sync path the
  // terminology page uses. Renderings start empty — the translator fills them
  // in later from the Terminology page.
  const handleAddConceptFromSelection = useCallback(async (sourceTerm: string) => {
    if (!project) return
    const trimmed = sourceTerm.trim()
    if (!trimmed) return
    const draft: Omit<Concept, "id" | "createdAt"> = {
      sourceTerm: trimmed,
      renderings: [],
      status: "draft",
      createdBy: currentUsername,
    }
    const updated = addConcept(project, draft)
    await patchSettings({ terminology: updated.terminology ?? [] })
  }, [project, currentUsername, patchSettings])

  /** Called when a user manually saves an edited BT from the BT tab. */
  const saveBacktranslation = useCallback((cell: CellData, btText: string, polished: boolean) => {
    setBacktranslationCache((prev) => new Map(prev).set(cell.id, btText))
    persistBt(cell, btText, polished)
  }, [persistBt])

  // ── FRO-192: assignment data ──────────────────────────────────────────────
  // Members list: used by AssignModal for the assignee picker and for building
  // the username→userId reverse map.
  const { members: projectMembers } = useProjectMembers(project?.id ?? null)

  // Current user's open assignments in this project, fetched once on mount and
  // on each new assignment (assignmentsRefreshKey increment).
  const [myAssignments, setMyAssignments] = useState<MyAssignment[]>([])
  // Manager's view: per-assignee open workload in this project.
  // Fetched eagerly so the data is warm when the manager opens the assign modal.
  const [_projectWorkload, setProjectWorkload] = useState<AssigneeWorkload[]>([])
  const currentRoleLevel = project?.syncRole?.level ?? 0
  // AQU-496: below PROJECT_LEAD, still allowed when the org has opted into
  // allowSelfAssignment (member may self-assign; AssignModal enforces the
  // self-only restriction on submit).
  const canAssignWork = canOpenAssignUi(currentRoleLevel, allowSelfAssignment)
  // AQU-496: the caller's own Frontier user id, resolved from the project
  // member list by username — used to lock AssignModal's assignee picker to
  // "self" in self-assign mode. Null if the roster hasn't loaded yet or the
  // caller isn't in it (e.g. platform-admin path) — AssignModal fails closed
  // in that case (no eligible assignee shown), not open.
  const currentUserId = projectMembers.find((m) => m.username === currentUsername)?.userId ?? null
  const jwt = frontierSession?.jwt ?? null

  // AQU-559: presence frames stamped by the sync DO carry `auth.claims.username`,
  // but legacy tokens without a username claim fall back to a `user:<numericId>`
  // form. Register that fallback identity as "self" once the roster resolves the
  // numeric id, so the user never sees their own presence circle on cells.
  useEffect(() => {
    if (currentUserId == null) return
    presenceStore.addSelfId(`user:${currentUserId}`)
  }, [presenceStore, currentUserId])

  useEffect(() => {
    if (!jwt || !project?.id) return
    let cancelled = false
    void getMyAssignments(jwt, project.id)
      .then((data) => { if (!cancelled) setMyAssignments(data) })
      .catch(() => { /* silently ignore — no assignments or no server access */ })
    return () => { cancelled = true }
  }, [jwt, project?.id, assignmentsRefreshKey])

  useEffect(() => {
    if (!jwt || !project?.id || !canAssignWork) return
    let cancelled = false
    void getProjectAssignments(jwt, project.id)
      .then((data) => { if (!cancelled) setProjectWorkload(data) })
      .catch(() => { /* silently ignore */ })
    return () => { cancelled = true }
  }, [jwt, project?.id, canAssignWork, assignmentsRefreshKey])

  // Build a cellId → {username, scopeLabel} map for the EditorTable gutter.
  // Strategy: match each cell against the active assignments using fileId and
  // globalReferences prefix (chapter LIKE 'BOOK CH:%').
  const assignmentsByCellId = useMemo((): ReadonlyMap<string, { username: string; scopeLabel: string }> => {
    const map = new Map<string, { username: string; scopeLabel: string }>()
    if (myAssignments.length === 0 || !activeFileId) return map
    for (const a of myAssignments) {
      if (a.projectId !== project?.id) continue
      // For this file's cells, mark all cells (book-scope) or only chapter-matched ones.
      for (const cell of cellSummaries) {
        if (cell.fileId !== activeFileId) continue
        if (a.scopeKind === "chapters") {
          // Match: globalReferences[0] starts with "CHAPTER:" where CHAPTER is
          // one of the chapters listed in scopeLabel (e.g. "GEN 1, GEN 2 in Genesis").
          // We parse chapter tokens as the comma-separated prefix before " in ".
          const beforeIn = a.scopeLabel.split(" in ")[0] ?? a.scopeLabel
          const chapters = beforeIn.split(",").map((s) => s.trim()).filter(Boolean)
          const ref = cell.globalReferences?.[0] ?? ""
          const refChapter = ref.includes(":") ? ref.slice(0, ref.indexOf(":")).trim() : ref.trim()
          if (chapters.some((ch) => ch === refChapter)) {
            map.set(cell.id, { username: currentUsername, scopeLabel: a.scopeLabel })
          }
        } else {
          // Book scope: all cells in the file are assigned.
          map.set(cell.id, { username: currentUsername, scopeLabel: a.scopeLabel })
        }
      }
    }
    return map
  }, [myAssignments, cellSummaries, activeFileId, project?.id, currentUsername])

  const backtranslating = backtranslatingState
  const backtranslationErrors = backtranslationErrorsState

  const requiredValidations = project ? readValidationCount(project) : 1
  const healthFileCells = useMemo(() => {
    const map = new Map<string, readonly CellSummary[]>()
    if (activeFileId) map.set(activeFileId, cellSummaries)
    return map
  }, [activeFileId, cellSummaries])

  // AD-14: health derives from decay (endorsement_count). The legacy
  // four-sub-score "composite-health" path is retired.
  const health = useHealth(
    healthFileCells,
    rules,
    { decaySettings: project?.decaySettings, requiredValidations },
  )
  // AQU-599: cellOpenCommentCount from useHealth is intentionally not consumed
  // here — see liveCellOpenCommentCount above (health's copy is empty in Phase
  // 2a). openCommentCount (file-level) is still health-derived.
  const { healthMap, fileHealth: _fileHealth, projectHealth, fileProgress: liveFileProgress, infractions, openCommentCount } = health

  // AQU-516: useHealth (above) only ever sees the currently-open file, so
  // fileProgress historically had an entry for at most one file — every
  // *other* row in the sidebar's FileRow rendered no progress bars at all.
  // Fetch the server-projected per-file rollup (same source the PM dashboard's
  // file table reads — org/ProjectOverview.tsx) once per project so every
  // file gets a snapshot, then merge the live, per-keystroke-accurate entry
  // for the open file back on top so it doesn't regress to the last fetch.
  const [allFilesProgressSnapshot, setAllFilesProgressSnapshot] = useState<
    Map<string, { translated: number; validated: number; total: number }>
  >(new Map())
  const progressSnapshotTokenFileId = project?.files[0]?.id ?? null
  const refreshAllFilesProgress = useCallback(async () => {
    if (!project?.id || !progressSnapshotTokenFileId) {
      setAllFilesProgressSnapshot(new Map())
      return
    }
    const token = await getTokenForFile(progressSnapshotTokenFileId)
    if (!token) throw new Error("project progress token unavailable")
    const summaries = await fetchProjectFiles(project.id, token)
    setAllFilesProgressSnapshot(fileSummariesToProgress(summaries))
  }, [getTokenForFile, progressSnapshotTokenFileId, project?.id])
  useEffect(() => {
    void refreshAllFilesProgress()
      .catch(() => {
        // Non-fatal — sidebar rows simply fall back to no progress bar
        // (existing behavior) until the next successful fetch.
      })
    // Re-fetch whenever the file count changes (import/delete) so newly
    // added files pick up a snapshot without a full reload.
  }, [project?.files.length, refreshAllFilesProgress])
  const fileProgress = useMemo(
    () => mergeFileProgress(allFilesProgressSnapshot, liveFileProgress),
    [allFilesProgressSnapshot, liveFileProgress],
  )
  // SWARM-TODO(AQU-516) live-verify: open a project with multiple files,
  // don't open any file — every file in the sidebar should show a progress
  // indicator (amber/emerald bars in FileRow), and the numbers should match
  // the PM dashboard's file table (org/ProjectOverview.tsx, same
  // fetchProjectFiles source). Then open one file and confirm its bars stay
  // live-accurate (move on edit) rather than freezing at the snapshot value.

  // PROTOTYPE (AD-14 health-as-confidence): derive per-cell health on read from
  // FTS5 similarity to validated cells, and overlay it onto the endorsement
  // healthMap for the editor rings/tooltip so we can compare the two live.
  //
  // OPT-IN, default OFF. The overlay's async refetch re-renders the editor when
  // it resolves, which races fast in-cell interactions (it reset cells mid-edit
  // and mid-completion, failing the validate + AI-completion e2e smokes). Until
  // that re-render is made non-disruptive, keep it behind a flag. Enable while
  // exploring with: `localStorage.setItem("health-confidence-overlay","1")` then
  // reload. When off, the hook is fully inert and the editor matches baseline.
  const confidenceOverlayEnabled = useMemo(() => {
    try {
      return localStorage.getItem("health-confidence-overlay") === "1"
    } catch {
      return false
    }
  }, [])
  const confidence = useCellConfidence({
    projectId: project?.id,
    fileId: activeFileId ?? undefined,
    getToken: activeFileId ? () => getTokenForFile(activeFileId) : undefined,
    cells: cellSummaries,
    enabled: confidenceOverlayEnabled && Boolean(project?.id && activeFileId && frontierSession?.jwt),
    perHopDecay: project?.decaySettings?.perHopDecay,
  })
  const effectiveHealthMap = useMemo(() => {
    if (!confidenceOverlayEnabled || confidence.healthMap.size === 0) return healthMap
    const merged = new Map(healthMap)
    for (const [cellId, h] of confidence.healthMap) merged.set(cellId, h)
    return merged
  }, [confidenceOverlayEnabled, healthMap, confidence.healthMap])

  // AD-14: the four-sub-score breakdown popover is retired. The project ring
  // shows decay-derived health; the "biggest drags" popover redesign (cells
  // sorted by descending decay) is a deferred follow-up.

  const jumpToCellId = useCallback((cellId: string) => {
    const idx = cellStore.findIndexByCellId(cellId)
    if (idx >= 0) {
      editorRef.current?.scrollToCellIndex(idx)
      editorRef.current?.flashCell(cellId, "")
    }
  }, [cellStore])

  const pendingPresenceJumpRef = useRef<{ fileId: string; cellId?: string } | null>(null)
  const handleJumpToPresencePeer = useCallback((peer: ProjectPresencePeer) => {
    const targetFileId = peer.currentFileId ?? activeFileId
    if (!targetFileId) return
    if (targetFileId !== activeFileId) {
      pendingPresenceJumpRef.current = {
        fileId: targetFileId,
        ...(peer.focusedCell ? { cellId: peer.focusedCell } : {}),
      }
      workspaceTabs.openFile(targetFileId)
      return
    }
    if (peer.focusedCell) jumpToCellId(peer.focusedCell)
  }, [activeFileId, jumpToCellId, workspaceTabs])

  useEffect(() => {
    const pending = pendingPresenceJumpRef.current
    if (!pending || pending.fileId !== activeFileId) return
    if (!pending.cellId) {
      pendingPresenceJumpRef.current = null
      return
    }
    const idx = readAtVersion(cellStoreVersion, () => cellStore.findIndexByCellId(pending.cellId!))
    if (idx < 0) return
    pendingPresenceJumpRef.current = null
    editorRef.current?.scrollToCellIndex(idx)
    editorRef.current?.flashCell(pending.cellId, "")
  }, [activeFileId, cellStore, cellStoreVersion])

  // Phase 0.5: run the deterministic check over the open file's cells.
  // Scope = the open file (the editor's working unit; chapters only exist as
  // sidebar section labels). Pure + chunked — no network, no LLM.
  const runCheck = useCallback(async () => {
    if (!activeFileId || checkRunning) return
    // One aside panel at a time (matches the existing drawer pattern).
    setDrawerRuleId(null)
    setCommentsCellId(null)
    setHistoryCellId(null)
    setCheckOpen(true)
    setCheckRunning(true)
    try {
      const result = await runDeterministicCheck({
        fileId: activeFileId,
        cells: readAtVersion(cellStoreVersion, getActiveCells),
        rules,
        concepts: project?.terminology ?? [],
      })
      // Bail if the active file changed mid-run — don't clobber the new file's
      // state with this (now stale) file's findings.
      if (!shouldApplyCheckResult(result.fileId, activeFileIdRef.current)) return
      setCheckResult(result)
    } finally {
      setCheckRunning(false)
    }
  }, [activeFileId, checkRunning, cellStoreVersion, getActiveCells, rules, project?.terminology])

  // A check run describes one file's cells; switching files invalidates it.
  useEffect(() => {
    setCheckResult(null)
    setCheckOpen(false)
  }, [activeFileId])

  // FRO-192: jump to the first cell matching an assignment's scopeLabel.
  // Uses the same globalReferences prefix match as assignmentsByCellId build.
  const jumpToScopeLabel = useCallback((scopeLabel: string) => {
    const chapterPart = scopeLabel.split(" in ")[0]?.trim() ?? scopeLabel
    const chapters = chapterPart.split(",").map((s) => s.trim()).filter(Boolean)
    let idx = -1
    for (const ch of chapters) {
      idx = cellStore.findIndexBySection(ch)
      if (idx >= 0) break
    }
    // If no chapter match, try scopeLabel against file name (book scope)
    if (idx < 0) idx = 0  // scroll to top as best effort
    editorRef.current?.scrollToCellIndex(idx)
  }, [cellStore])

  // ── last-location: write on file change ──────────────────────────────────
  // Persist the active file whenever it changes so a fresh open resumes here.
  // Cell-level granularity is written by handleClaimCell below (debounced).
  useEffect(() => {
    if (!projectId || !activeFileId) return
    writeLastLocation(currentUsername, projectId, { fileId: activeFileId })
  }, [projectId, activeFileId, currentUsername])

  // ── last-location: scroll to remembered cell once cells are loaded ────────
  // After a restore-navigation the editor isn't rendered yet; we park the
  // target cellId in pendingCellScrollRef and consume it here once `cells`
  // is non-empty and the ref is set.
  useEffect(() => {
    const cellId = pendingCellScrollRef.current
    if (!cellId || cellStore.getCellCount() === 0) return
    const idx = readAtVersion(cellStoreVersion, () => cellStore.findIndexByCellId(cellId))
    if (idx >= 0) {
      pendingCellScrollRef.current = null
      editorRef.current?.scrollToCellIndex(idx)
    }
  }, [cellStore, cellStoreVersion])

  const drawerRule = rules.find((r) => r.id === drawerRuleId) || null
  const drawerInfractions = drawerRuleId
    ? Array.from(infractions.values()).flat().filter((i) => i.ruleId === drawerRuleId)
    : []
  const drawerCellsByFile = useMemo(() => {
    const map = new Map<string, CellData[]>()
    if (drawerRuleId && activeFileId) map.set(activeFileId, readAtVersion(cellStoreVersion, getActiveCells))
    return map
  }, [activeFileId, cellStoreVersion, drawerRuleId, getActiveCells])

  // Parallel-passages shortcuts (mirrors codex-editor):
  //   Cmd/Ctrl+F        → search in current file
  //   Cmd/Ctrl+K        → search across all files (alias)
  //   Cmd/Ctrl+Shift+F  → search across all files
  //   Cmd/Ctrl+Shift+R  → search + replace across all files
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const key = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        if (!activeFileId || !hasUnfinished) return
        e.preventDefault()
        handleJumpNextUnfinished()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (key === "f" || key === "k")) {
        e.preventDefault()
        setParallelMode("search")
        setParallelScope(
          key === "k" ? "project" : e.shiftKey ? "project" : activeFileId ? "file" : "project",
        )
        setParallelOpen(true)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && key === "r") {
        e.preventDefault()
        setParallelMode("replace")
        setParallelScope("project")
        setParallelOpen(true)
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [activeFileId, hasUnfinished, handleJumpNextUnfinished])

  // Legacy sync status shim. AD-1 live coordination uses the project
  // WebSocket below; this hook only feeds the existing status indicator.
  const { status: fileSyncStatus } = useFileSync({
    doc,
    projectId: project?.id ?? null,
    fileId: activeFileId || null,
    username: currentUsername,
    enabled: Boolean(project && activeFileId),
    session: frontierSession,
    projectName: project?.name ?? null,
    gitlabProjectId:
      project?.origin?.kind === "git" ? project.origin.gitlabProjectId : null,
  })

  // Phase 2c-gamma: cross-collaborator settings sync was piggybacked on the
  // active file's Y.Doc meta; that broadcast channel is gone. Settings still
  // persist locally and via the project record fetch.

  // Phase 2c-β: per-project WS reconciler. Subscribes to the per-project
  // Durable Object for presence + focus locks + `event.applied` broadcasts.
  // The outbox flusher (above) ships writes; this connection drives reads.
  const [cellLockHolders, setCellLockHolders] = useState<Map<string, string>>(() => new Map())
  // RACE-5: ref that mirrors cellLockHolders, updated synchronously on each WS
  // frame so handleEditorCommit (checkLockHolder) always reads the latest state
  // rather than a stale React closure captured at the last render.
  const cellLockHoldersRef = useRef<Map<string, string>>(new Map())
  const [cellsWithRemoteChange, setCellsWithRemoteChange] = useState<Set<string>>(() => new Set())
  const focusedCellIdRef = useRef<string | null>(null)
  // Reactive version of focusedCellIdRef for the agent panel's context wiring.
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null)

  // FRO-179: TN sidebar visibility + canonicalRef of the focused cell.
  // Hidden by default; toggled via the View settings menu.
  const [tnSidebarVisible, setTnSidebarVisible] = useState<boolean>(() =>
    projectId ? readTnSidebarVisible(projectId) : false,
  )
  const [focusedCellCanonicalRef, setFocusedCellCanonicalRef] = useState<string | null>(null)

  // Scripture context for the chat dock's Summarize book/chapter buttons. A
  // "Bible file" is one whose format is scripture (usfm/ebible/helloao), carries
  // a corpus marker, or whose focused cell has a canonical ref. The chapter is
  // the ref minus the verse, e.g. "GEN 1:1" → "GEN 1".
  const bibleSummary = useMemo(() => {
    if (!activeFile) return null
    const isScripture =
      ["usfm", "ebible", "helloao"].includes(activeFile.type) ||
      Boolean(activeFile.corpusMarker) ||
      Boolean(focusedCellCanonicalRef)
    if (!isScripture) return null
    const chapterRef = focusedCellCanonicalRef
      ? focusedCellCanonicalRef.split(":")[0].trim()
      : null
    return { bookName: activeFile.name, chapterRef }
  }, [activeFile, focusedCellCanonicalRef])
  // Parallel-bibles sidebar (helloao): open state persisted per project, plus
  // the canonical ref the panel follows. Fed by two signals, most recent
  // wins: the first visible editor row (scroll) and the focused cell
  // (click / tab navigation in handleClaimCell).
  const [parallelBiblesOpen, setParallelBiblesOpen] = useState<boolean>(() =>
    projectId ? readParallelBiblesOpen(projectId) : false,
  )
  const [trackedCellRef, setTrackedCellRef] = useState<string | null>(null)
  // Drop the tracked ref when switching files so the previous file's verse
  // doesn't leak into the new file's panel (the new EditorTable re-fires).
  useEffect(() => {
    setTrackedCellRef(null)
  }, [activeFileId])
  const reconcilerRef = useRef<import("@/lib/sync/ws-reconciler").WsReconciler | null>(null)
  // FRO-288: Reactive reconciler state so useFocusLock can access it.
  // reconcilerRef is still the write target (set inside the async connect effect)
  // and is used by the claim/release callbacks declared below.
  const [liveReconciler, setLiveReconciler] = useState<WsReconciler | null>(null)
  // Read the current file list inside the WS connect path without making it a
  // reconnect trigger — otherwise every file-list change (e.g. each batch of a
  // large import landing) tears the socket down and recreates it.
  const projectFilesRef = useRef(projectFiles)
  projectFilesRef.current = projectFiles
  const presenceStaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearPresenceStaleTimer = useCallback(() => {
    if (presenceStaleTimerRef.current === null) return
    clearTimeout(presenceStaleTimerRef.current)
    presenceStaleTimerRef.current = null
  }, [])

  const clearRemotePresenceState = useCallback(() => {
    cellLockHoldersRef.current = new Map()
    setCellLockHolders(new Map())
    presenceStore.reset()
  }, [presenceStore])

  const sendPresenceUpdate = useCallback((patch: {
    currentFileId?: string | null
    focusedCell?: string | null
    selection?: TargetPresenceSelection | null
  }) => {
    reconcilerRef.current?.send({ t: "presence.update", ...patch })
  }, [])

  useEffect(() => {
    if (!project?.id || !frontierSession?.jwt) return
    let cancelled = false
    let reconciler: import("@/lib/sync/ws-reconciler").WsReconciler | null = null
    void (async () => {
      const { createWsReconciler, isOwnWriteEcho, isValidationEvent, createLinkUpstreamChangedHandler } =
        await import("@/lib/sync/ws-reconciler")
      const { syncWorkerHttpOrigin } = await import("@/lib/sync/sync-worker-url")
      if (cancelled || !project?.id) return
      const pid = project.id
      // FRO-479: link.upstream-changed frames → refetch staleness immediately
      // (cheap GET, reflects the frame as soon as possible), and — debounced —
      // AWAIT the mirror sync, then revalidate BOTH staleness and cells.
      // QA-BUG-2: previously `triggerLinkSync` just re-ran the fire-and-forget
      // stale-source fetch, which raced the mirror commit and never refreshed
      // cells at all — the badge went live but the mirrored source TEXT only
      // updated on a manual reload. Sequencing the revalidates AFTER the sync
      // POST resolves (syncStaleSourceNow awaits it) fixes both: cells finally
      // refetch post-commit, and staleness settles on the correct tone
      // instead of the transient pre-sync "violet" (QA-BUG-3's other half).
      const handleLinkUpstreamChanged = createLinkUpstreamChangedHandler({
        currentProjectId: () => pid,
        revalidateStaleSource: () => staleSourceRevalidateRef.current(),
        triggerLinkSync: () => {
          void syncStaleSourceNowRef.current().then(() => {
            revalidateCellsRef.current()
          })
        },
      })
      reconciler = createWsReconciler(
        {
          projectId: pid,
          userId: currentUsername,
          baseUrl: syncWorkerHttpOrigin(),
          getToken: async () => {
            // The per-project DO authenticates with verifyTokenForProject,
            // which checks only projectId and ignores the token's fileId. The
            // workspace's only mint path is file-scoped, so for a fileless
            // project (nothing imported yet) we'd otherwise return null and the
            // WS would never authenticate — breaking presence/focus-locks until
            // the first file lands. Mint against a sentinel fileId instead; the
            // DO discards it. (identity's /sync-token requires fileId.min(1).)
            const aFile = projectFilesRef.current[0]?.id ?? "__project__"
            return getTokenForFile(aFile)
          },
        },
        {
          onOpen() {
            if (cancelled) return
            clearPresenceStaleTimer()
            sendPresenceUpdate({
              currentFileId: activeFileIdRef.current,
              selection: null,
            })
          },
          onClose() {
            if (cancelled) return
            if (presenceStaleTimerRef.current !== null) return
            presenceStaleTimerRef.current = setTimeout(() => {
              presenceStaleTimerRef.current = null
              clearRemotePresenceState()
            }, PRESENCE_LOCK_STALE_CLEAR_MS)
          },
          onMessage(msg) {
            if (msg.t === "event.applied") {
              if (msg.file && msg.project === pid && (
                msg.kind?.startsWith('source.cell.') ||
                msg.kind?.startsWith('target.cell.') ||
                msg.kind === 'cell.validate' ||
                msg.kind === 'cell.unvalidate'
              )) {
                invalidateFileProgress(pid, msg.file)
              }
              // File-scoped events (file.create / file.rename) carry no cell;
              // they change the project's file inventory or labels. Re-pull the
              // project so renames + new files surface live and the local
              // optimistic rename overlay reconciles against server truth.
              if (!msg.cell && msg.kind?.startsWith("file.") && msg.project === pid) {
                refresh()
                return
              }
              // FRO-228: comment.* events are non-chain-mutating and carry no
              // cell in the WS frame. Refresh the comments projection so the
              // server-persisted comment surfaces after the outbox flushes —
              // especially important for remote collaborators who never had the
              // optimistic state.
              if (msg.kind?.startsWith("comment.") && msg.project === pid) {
                void refreshComments()
                return
              }
              if (!msg.cell || msg.project !== pid) return
              if (msg.file) invalidateCellHistory(pid, msg.file, msg.cell)
              const ownWrite = isOwnWriteEcho(msg, currentUsername)
              // Validation state has two projections: `cells.validated` drives
              // progress, while `cell_validators` identifies who approved the
              // current edit. Refresh the audit row from the applied-event echo
              // for both local and remote writes so the per-cell button cannot
              // remain visually stale after the progress count turns green.
              // The committing handler's earlier refresh can race the app-shell
              // outbox drain; this frame only arrives after projection commits.
              if (msg.kind === "cell.validate" || msg.kind === "cell.unvalidate") {
                revalidateCellStats(msg.cell)
              }
              // Targeted single-cell refetch — avoids re-streaming every
              // cell in the file for one remote change. Falls back to a
              // full revalidate inside useCells on error.
              //
              // Skip it for our OWN writes: the committing handler already
              // pulled the authoritative row after its outbox flush, so the
              // echo's refetch is pure duplication (and the in-flight coalescer
              // misses it because the handler's refetch is gated behind the
              // flush — see isOwnWriteEcho). The FRO-247 shadow keeps the value
              // visible until the handler's read lands. This is the dominant
              // edit-cycle cost: every commit + validate + auto-BT echo was
              // firing a redundant targeted GET (~5 of 8 per edit cycle).
              if (!ownWrite) {
                revalidateCell(msg.cell)
                // activeValidators (the validation pill) comes from the
                // audit-stats projection, not /files/:fileId/cells — a remote
                // validate/unvalidate must poke that read too, or the pill
                // stays stale until the next full stats poll.
                if (isValidationEvent(msg.kind)) {
                  revalidateCellStats(msg.cell)
                }
              }
              // Audio attachment events project into cell_audio (not cells);
              // poke the per-file audio read so the new clip surfaces. This
              // runs even for own writes — the committing handler refetches
              // the cells row, not the per-file audio attachments.
              if (msg.kind?.startsWith("cell.audio.") && msg.file) {
                notifyAudioAttachmentsChanged(msg.file)
              }
              // Don't pop the "remote changed" banner for our own writes —
              // the editor just committed; bouncing the same event back via
              // WS is expected. Older builds omit `by` (isOwnWriteEcho → false)
              // and fall through to the legacy "always banner on focused cell"
              // path so the user can still tell something happened.
              if (ownWrite) return
              if (focusedCellIdRef.current === msg.cell) {
                setCellsWithRemoteChange((cur) => {
                  if (cur.has(msg.cell!)) return cur
                  const next = new Set(cur)
                  next.add(msg.cell!)
                  return next
                })
              }
            } else if (msg.t === "file.progress.updated") {
              if (msg.project !== pid) return
              invalidateFileProgress(pid, msg.file)
              void refreshAllFilesProgress().catch(() => {
                // The next normal sidebar refresh retries a transient token or
                // network failure. Do not turn a realtime hint into an
                // unhandled rejection.
              })
              // The first import chunk owns file.create. Refresh the project
              // inventory so remote users see the new row immediately; later
              // bulk chunks do not cause an editor-wide reload storm.
              if (msg.fileCreated) {
                refresh()
              } else if (activeFileIdRef.current === msg.file) {
                // The bulk uploader emits this final frame only after every
                // concurrent chunk committed, so one full read is enough for
                // a collaborator who already has that file open.
                revalidateCellsRef.current()
              }
            } else if (msg.t === "project.settings.updated") {
              if (msg.project !== pid) return
              window.dispatchEvent(new CustomEvent("aquilla:project-settings-updated", {
                detail: { projectId: pid, version: msg.version },
              }))
              // A validation-threshold change alters every file's derived
              // validated count without mutating its progress histogram.
              invalidateProjectFileProgress(pid)
              void refreshAllFilesProgress().catch(() => {
                // The next normal sidebar refresh retries a transient token or
                // network failure.
              })
              // Settings projection changes `cells.validated` without adding
              // cell events, so a `?since=` delta would be empty. Drop the
              // watermark to make the active editor read one authoritative
              // snapshot and keep row validation UI in sync.
              cellStore.setMaxServerSeq(null)
              revalidateCellsRef.current()
            } else if (msg.t === "link.upstream-changed") {
              // FRO-479: an upstream live-link project committed lane-relevant
              // changes. Refetch staleness immediately; the handler debounces
              // the mirror-sync trigger (push is a lossy accelerator — the
              // lazy pull on file open remains the self-healing floor).
              handleLinkUpstreamChanged(msg)
            } else if (msg.t === "presence") {
              presenceStore.applyPresenceFrame(msg.users)
              // FRO-288: forward presence snapshots to the focus-lock hook so
              // it can update heldBy when another user holds our focused cell.
              focusLockFeedFrameRef.current(msg)
              // B4 fix: applyPresenceFrame always returns a NEW Map, so ref and
              // state never share the same object — subsequent handlers cannot
              // cause React's bail-out by mutating the shared instance in place.
              // RACE-5: update ref synchronously so checkLockHolder reads
              // the latest state even before the React re-render completes.
              const next = applyPresenceFrame(msg.users, currentUsername)
              if (sameStringMap(cellLockHoldersRef.current, next)) return
              cellLockHoldersRef.current = next
              setCellLockHolders(next)
            } else if (msg.t === "lock.claimed") {
              presenceStore.applyLockClaimed(msg.cellId, msg.by.userId)
              // FRO-288: forward lock.claimed to the hook so it can update
              // isHeld / heldBy and stop our renewal timer on takeover.
              focusLockFeedFrameRef.current(msg)
              if (msg.by.userId === currentUsername) return
              // B4 fix: build ONE new Map from the ref (authoritative, always
              // current), assign to ref synchronously (RACE-5 preserved), and
              // pass that same new Map to setState — new identity guarantees
              // React re-renders even when this is a lone lock.claimed frame.
              const next = applyLockClaimed(
                cellLockHoldersRef.current,
                msg.cellId,
                msg.by.userId,
              )
              cellLockHoldersRef.current = next
              setCellLockHolders(next)
            } else if (msg.t === "lock.released") {
              presenceStore.applyLockReleased(msg.cellId)
              // FRO-288: forward lock.released so the hook clears heldBy.
              focusLockFeedFrameRef.current(msg)
              // B4 fix: same pattern — new Map from ref, sync ref, direct setState.
              // Prevents the bail-out that left cells visually locked after a
              // lease-expiry sweep (which broadcasts a lone lock.released frame).
              const next = applyLockReleased(cellLockHoldersRef.current, msg.cellId)
              cellLockHoldersRef.current = next
              setCellLockHolders(next)
            } else if (msg.t === "project.archived") {
              if (msg.project !== pid) return
              void patchProject(pid, (p) => {
                if (msg.archivedAt) {
                  return {
                    ...p,
                    deletedAt: msg.archivedAt,
                    deletedBy: msg.deletedBy ?? p.deletedBy,
                  }
                }
                const next = { ...p }
                delete next.deletedAt
                delete next.deletedBy
                return next
              }).then(() => refresh())
            } else if (msg.t === "member.removed") {
              // FRO-346: this user's membership was revoked; the DO closes
              // the socket right after this frame. Re-fetch the project —
              // the server now 403s, which flips useProject to "forbidden",
              // unmounts the editor (project → null tears this reconciler
              // down via the effect cleanup) and shows the clean
              // "you no longer have access" state.
              if (msg.project !== pid || msg.userId !== currentUsername) return
              refresh()
            }
          },
        },
      )
      reconcilerRef.current = reconciler
      setLiveReconciler(reconciler)
    })()
    return () => {
      cancelled = true
      clearPresenceStaleTimer()
      reconcilerRef.current = null
      setLiveReconciler(null)
      reconciler?.close()
    }
  }, [
    project?.id,
    frontierSession?.jwt,
    getTokenForFile,
    revalidateCells,
    revalidateCell,
    revalidateCellStats,
    currentUsername,
    refresh,
    clearPresenceStaleTimer,
    clearRemotePresenceState,
    presenceStore,
    sendPresenceUpdate,
    refreshAllFilesProgress,
  ])

  // FRO-288: workspace-level focus-lock with renewal.
  // useFocusLock is driven by focusedCellId (the reactive mirror of
  // focusedCellIdRef) and liveReconciler (set once the async WS connect
  // resolves). The hook starts a half-period renewal timer on every claim(),
  // so the 30s DO lease never expires mid-edit under normal activity.
  // feedFrameRef lets the onMessage handler (inside the connect effect closure)
  // forward lock.claimed / lock.released / presence frames to the hook without
  // breaking hook call order.
  const [focusLockState, focusLockFeedFrame] = useFocusLock({
    reconciler: liveReconciler,
    cellId: focusedCellId,
    // AQU-538: lane-qualify the focus lease so per-lane editors don't contend.
    lane: activeLane,
    currentUserId: currentUsername,
  })
  const focusLockFeedFrameRef = useRef(focusLockFeedFrame)
  useEffect(() => { focusLockFeedFrameRef.current = focusLockFeedFrame }, [focusLockFeedFrame])

  const writeLocTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleClaimCell = useCallback((cellId: string) => {
    focusedCellIdRef.current = cellId
    setFocusedCellId(cellId) // FRO-175: reactive for chat panel context
    // FRO-179: update TN sidebar with the focused cell's canonicalRef.
    const focusedCell = getActiveCell(cellId)
    setFocusedCellCanonicalRef(focusedCell?.group ?? null)
    // Parallel-bibles panel: navigating to a cell is a stronger "looking at"
    // signal than the scroll position — the panel follows whichever moved last.
    if (focusedCell?.group) setTrackedCellRef(focusedCell.group)
    // FRO-288: focusLockState.claim() replaces the bare focus.claim send.
    // The hook sends focus.claim and starts the half-period renewal timer so
    // the 30s DO lease never silently expires mid-edit.
    sendPresenceUpdate({
      currentFileId: activeFileIdRef.current,
      selection: null,
    })
    focusLockState.claim(cellId)
    // Debounce last-location cell write (500 ms) so rapid focus events
    // don't hammer localStorage.
    if (writeLocTimerRef.current !== null) clearTimeout(writeLocTimerRef.current)
    writeLocTimerRef.current = setTimeout(() => {
      writeLocTimerRef.current = null
      if (!projectId || !activeFileId) return
      writeLastLocation(currentUsername, projectId, { fileId: activeFileId, cellId })
    }, 500)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, activeFileId, currentUsername, focusLockState.claim, getActiveCell, sendPresenceUpdate])
  const handleReleaseCell = useCallback((cellId: string) => {
    if (focusedCellIdRef.current === cellId) focusedCellIdRef.current = null
    // Deliberately keep focusedCellId / focusedCellCanonicalRef: the chat
    // panel and TN sidebar need the *last* focused cell as context — clicking
    // away (e.g. to open chat) releases the focus lock but shouldn't drop the
    // context the user was just working in. Both reset on file switch below.
    // FRO-288: hook's release() sends focus.release + stops renewal timer.
    focusLockState.release()
    sendPresenceUpdate({
      currentFileId: activeFileIdRef.current,
      focusedCell: null,
      selection: null,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLockState.release, sendPresenceUpdate])
  const handleTargetPresenceSelection = useCallback((
    cellId: string,
    selection: TargetPresenceSelection | null,
  ) => {
    if (focusedCellIdRef.current !== cellId) return
    sendPresenceUpdate({
      currentFileId: activeFileIdRef.current,
      selection,
    })
  }, [sendPresenceUpdate])
  // Last-focused context is per-file: a cell from the previous file is stale
  // once the user opens another one.
  useEffect(() => {
    focusedCellIdRef.current = null
    setFocusedCellId(null)
    setFocusedCellCanonicalRef(null)
    sendPresenceUpdate({
      currentFileId: activeFileId,
      focusedCell: null,
      selection: null,
    })
  }, [activeFileId, sendPresenceUpdate])
  const handleAckRemoteChange = useCallback((cellId: string) => {
    setCellsWithRemoteChange((cur) => {
      if (!cur.has(cellId)) return cur
      const next = new Set(cur)
      next.delete(cellId)
      return next
    })
  }, [])

  // RACE-5: ref-backed lock check passed to EditorTable for commit-time
  // enforcement. Reads cellLockHoldersRef (updated synchronously on every
  // WS frame) so a debounce-queued commit can't slip through a stale render.
  // Returns the holder label, or null when the cell is free.
  const checkLockHolder = useCallback((cellId: string) =>
    cellLockHoldersRef.current.get(cellId) ?? null, [])

  // Stable identities for the EditorTable callback props below — EditorTable
  // rows are React.memo'd, so a new function identity here would fail the
  // shallow-compare for every visible row on every ProjectWorkspace render.
  const handleInfractionClick = useCallback((ruleId: string) => {
    setCommentsCellId(null); setHistoryCellId(null); setDrawerRuleId(ruleId)
  }, [])
  const handleOpenComments = useCallback((cellId: string) => {
    setDrawerRuleId(null); setHistoryCellId(null); setCommentsCellId(cellId)
  }, [])
  const handleOpenHistory = useCallback((cellId: string) => {
    setDrawerRuleId(null); setCommentsCellId(null); setHistoryCellId(cellId)
  }, [])
  const handleAiSetupNeeded = useCallback(() => setAiSetupOpen(true), [])
  const handleOpenRecording = useCallback((cellId: string) => setRecordingCellId(cellId), [])

  // FRO perf cleanup: the five openers above are pure pass-throughs through
  // EditorTable -> MemoizedRow -> EditorRow with no intermediate consumer, so
  // they've been moved off the row prop bag into EditorActionsContext. All
  // five deps are `[]`-memoized above, so this value's identity is stable —
  // the provider never forces a re-render of the table subtree.
  // (onAssignVoice/onOpenAudioSetup stay drilled: onAssignVoice's identity is
  // NOT stable — it closes over project/session state — and both are
  // entangled with the still-drilled audio-lens prop cluster in EditorRow's
  // audio section, so pulling just the callback into context wouldn't shrink
  // that section's prop surface.)
  const editorActionsValue = useMemo(() => ({
    onInfractionClick: handleInfractionClick,
    onOpenComments: handleOpenComments,
    onOpenHistory: handleOpenHistory,
    onAiSetupNeeded: handleAiSetupNeeded,
    onOpenRecording: handleOpenRecording,
  }), [handleInfractionClick, handleOpenComments, handleOpenHistory, handleAiSetupNeeded, handleOpenRecording])

  const handleAssignVoice = useCallback(async (cellId: string, voiceId: string) => {
    if (!audioProject || !frontierSession) return
    // First assign the voice to this cell in the cast
    tts.assignCells([cellId], voiceId)
    // Then synthesise with the newly assigned voice
    const targetCell = getActiveCell(cellId)
    if (!targetCell) return
    const ok = await generateCellVoice({
      project: audioProject,
      cell: targetCell,
      session: frontierSession,
      username: currentUsername,
      voiceId,
    })
    if (ok) refresh()
  }, [audioProject, frontierSession, tts.assignCells, getActiveCell, currentUsername, refresh])

  // Drives the editor-area rendering: loading skeleton vs. empty state vs.
  // EditorTable. Centralizes the decision so we don't flash between states
  // while a file hydrates.
  const cellAreaState = useMemo(
    () => deriveCellAreaState({
      activeFileId,
      cellCount: cellSummaries.length,
      syncStatus: fileSyncStatus,
      cellsLoading,
    }),
    [activeFileId, cellSummaries.length, fileSyncStatus, cellsLoading]
  )

  async function handleSearchSelect(result: WorkspaceSearchResult, query: string) {
    const flash = () => {
      const idx = cellStore.findIndexByCellId(result.cellId)
      if (idx >= 0) editorRef.current?.scrollToCellIndex(idx)
      editorRef.current?.flashCell(result.cellId, query)
    }
    if (result.fileId !== activeFileId) {
      workspaceTabs.openFile(result.fileId)
      setTimeout(flash, 400)
    } else {
      flash()
    }
  }

  const perms = useProjectPermissions(project)
  const isReadOnly = !perms.canEditContent

  const commitTrayFootnoteText = useCallback(async (cellId: string, updatedText: string) => {
    if (!project?.id || isReadOnly) return
    if (!canPerform("target.cell.commit", project.syncRole?.level ?? null)) return
    const cell = getActiveCell(cellId)
    if (!cell) return

    applyOptimisticTargetEditWithCapture(cell.id, { value: updatedText, valueHtml: updatedText })
    const parentId = resolveTargetCommitParentId(cell)
    const eventId = await emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      parentId,
      sourceEventId: cell.sourceEventId ?? null,
      value: updatedText,
      valueHtml: updatedText,
      author: currentUsername,
      targetLang: activeLane, // AQU-538: '' omitted on the wire by the emit
    })
    rememberPendingTargetCommit(cell.id, eventId, parentId)
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    // Single-cell edit — targeted refetch (see commitCompletedCell).
    revalidateCellStats(cell.id)
    revalidateCell(cell.id)
  }, [
    project?.id,
    project?.syncRole?.level,
    isReadOnly,
    getActiveCell,
    applyOptimisticTargetEditWithCapture,
    activeLane,
    resolveTargetCommitParentId,
    rememberPendingTargetCommit,
    currentUsername,
    getTokenForProjectFile,
    refreshOutboxPending,
    revalidateCellStats,
    revalidateCell,
  ])

  const handleTrayFootnoteSave = useCallback((cellId: string, footnoteIndex: number, newText: string) => {
    const cell = getActiveCell(cellId)
    if (!cell) return false
    const updated = spliceFootnoteText(cell.translated ?? "", footnoteIndex, newText)
    if (updated === null) return false // stale index — keep the editor open (FRO-472)
    void commitTrayFootnoteText(cellId, updated)
  }, [commitTrayFootnoteText, getActiveCell])

  const handleTrayFootnoteDelete = useCallback((cellId: string, footnoteIndex: number) => {
    const cell = getActiveCell(cellId)
    if (!cell) return
    const updated = deleteFootnote(cell.translated ?? "", footnoteIndex)
    void commitTrayFootnoteText(cellId, updated)
  }, [commitTrayFootnoteText, getActiveCell])

  const { state: checklistState, dismissed: checklistDismissed, dismiss: dismissChecklist, refreshShares: refreshChecklistShares } = useSetupChecklist(project ?? null)
  const [checklistOpen, setChecklistOpen] = useState(false)
  const [showChipTooltip, setShowChipTooltip] = useState(false)

  // Open setup once only when onboarding explicitly lands in the new project.
  // Ordinary project visits, refreshes, and collaborators opening the same
  // project should not auto-open the drawer.
  useEffect(() => {
    const routeState = location.state as { openSetupChecklist?: boolean } | null
    if (!routeState?.openSetupChecklist) return
    setChecklistOpen(true)
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: null,
    })
  }, [location.hash, location.pathname, location.search, location.state, navigate])

  const handleChecklistOpenChange = useCallback((next: boolean) => {
    setChecklistOpen(next)
    if (next || checklistDismissed) return
    // First close — persist the dismissal so we don't reopen on next nav,
    // and surface a one-time hint pointing at the chip.
    void dismissChecklist()
    let alreadyShown = false
    try { alreadyShown = localStorage.getItem("codex.checklistTooltipShown") === "1" } catch { /* ignore */ }
    if (!alreadyShown) {
      try { localStorage.setItem("codex.checklistTooltipShown", "1") } catch { /* ignore */ }
      setShowChipTooltip(true)
      window.setTimeout(() => setShowChipTooltip(false), 6000)
    }
  }, [checklistDismissed, dismissChecklist])

  const handleProjectUpdated = useCallback(async (updated: ProjectRecord | undefined) => {
    // FRO-234: When a step component saves (e.g. AiInstructionsStep via
    // useSaveCompletionSettings), it writes to IDB and hands us the updated
    // record. We must also push the change through patchSettings so that
    // useProjectSettings.local reflects it — that overlay is what
    // deriveChecklistState reads to compute aiInstructions. Without this call,
    // the checklist step never flips to complete because useProject.refresh()
    // fetches from the server (not IDB) and the server-overlay wins.
    //
    // WARN: only patch when the updated record carries a NON-EMPTY systemPrompt.
    // buildCompletionSettings() materialises systemPrompt as "" by default, so a
    // provider-only save (Device B changing the AI provider with no local prompt)
    // would otherwise WIPE the server-side prompt project-wide.
    //
    // Also gate on MAINTAINER (600) — same floor as handleImported — so viewers
    // and editors can't inadvertently overwrite project-wide settings they have
    // no server authority to change.
    const systemPrompt = updated?.completionSettings?.systemPrompt
    const roleLevel = project?.syncRole?.level ?? 0
    if (shouldPatchSystemPrompt(systemPrompt, roleLevel)) {
      void patchSettings({ systemPrompt: systemPrompt! })
    } else if (systemPrompt !== undefined && systemPrompt !== null && systemPrompt.trim().length === 0) {
      // Empty prompt from a provider-only save — silently skip to avoid clobbering the server.
    } else if (systemPrompt && roleLevel < ROLE.MAINTAINER) {
      console.warn(
        `[FRO-234] skipping systemPrompt patch — role ${roleLevel} is below server floor ${ROLE.MAINTAINER}. ` +
        "A sub-MAINTAINER device cannot write project-wide AI instructions.",
      )
    }
    // Also refresh the server-fetched base record so other fields stay in sync.
    refresh()
  }, [refresh, patchSettings, project?.syncRole?.level])

  // All hooks below must live above the early return so hook count is stable
  // across renders (React throws "Rendered more hooks" otherwise).

  const suggestions = useMemo(
    () => (project ? detectSuggestions(project) : []),
    [project]
  )
  const bannerSuggestions = useMemo(() => {
    if (!project || suggestionsDismissed || project.suggestionsDismissedAt) return []
    return suggestions
  }, [project, suggestions, suggestionsDismissed])
  const suggestionFileIds = useMemo(
    () => new Set(suggestions.map((s) => s.fileId)),
    [suggestions]
  )

  const [moveTargetId, setMoveTargetId] = useState<string | null>(null)
  const [moveCorpus, setMoveCorpus] = useState("")
  const existingCorpusMarkers = useMemo(() => {
    const set = new Set<string>()
    for (const f of project?.files ?? []) {
      const m = f.corpusMarker?.trim()
      if (m) set.add(m)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [project?.files])
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ chosen: RenameSuggestion[] } | null>(null)
  // FRO-272: soft-deleted ("Recently deleted") files fetched from the server.
  const [deletedFiles, setDeletedFiles] = useState<FileSummary[]>([])
  const [trashOpen, setTrashOpen] = useState(false)
  // Fetch trash list whenever the section opens or after a delete/restore/purge.
  const refreshDeletedFiles = useCallback(async () => {
    if (!project?.id || !frontierSession?.jwt) return
    try {
      const files = await fetchDeletedFiles(project.id, frontierSession.jwt)
      setDeletedFiles(files)
    } catch {
      // Non-fatal — trash section shows empty on error.
    }
  }, [project?.id, frontierSession?.jwt])
  useEffect(() => {
    if (trashOpen) void refreshDeletedFiles()
  }, [trashOpen, refreshDeletedFiles])

  const applyRenames = useCallback(async (
    renames: Array<{ fileId: string; name: string }>,
  ) => {
    if (!project || renames.length === 0) return
    // Optimistic: surface the new labels instantly (and let detectSuggestions
    // drop applied files from the banner) without waiting for the round-trip.
    setOptimisticRenames((current) => {
      const next = new Map(current)
      for (const r of renames) next.set(r.fileId, r.name)
      return next
    })
    // Durable: one file.rename event per file persists the label to the server
    // projection (AD-2) so it syncs to every collaborator. The refresh below
    // and the WS file.* poke reconcile the optimistic overlay against it.
    try {
      await Promise.all(
        renames.map((r) =>
          emitFileRename({
            projectId: project.id,
            fileId: r.fileId,
            name: r.name,
            author: currentUsername,
          }),
        ),
      )
    } catch (e) {
      console.error("[rename] file.rename emit failed", e)
    }
    refresh()
  }, [project, currentUsername, refresh])

  const handleRename = useCallback(async (fileId: string, newName: string) => {
    if (!project) return
    try {
      // Validate (empty / duplicate / not-found) with the pure transform; the
      // returned record is discarded — persistence flows through file.rename.
      renameFile(project, fileId, newName)
    } catch (e) {
      alert(e instanceof Error ? e.message : "Rename failed")
      return
    }
    await applyRenames([{ fileId, name: newName.trim() }])
  }, [project, applyRenames])

  // FRO-272: soft-delete via file.delete event. IDB removal is contingent on
  // server ack (fixes F-E6 fire-and-forget fork). The file moves to "Recently
  // deleted" in the trash UI; cells and audio are retained. R2 wipe deferred.
  const handleDeleteFile = useCallback(async (fileId: string) => {
    if (!project) return

    // Remove the row in the same interaction frame. Enqueuing is normally
    // quick, but IndexedDB can be delayed by another transaction; the visible
    // result of an acknowledged destructive action must not wait on it.
    setOptimisticDeletes((current) => {
      const next = new Set(current)
      next.add(fileId)
      return next
    })

    try {
      await emitFileDelete({
        projectId: project.id,
        fileId,
        author: currentUsername,
      })
    } catch (e) {
      console.error("[delete] file.delete emit failed", e)
      // The durable event never entered the outbox, so restore the row.
      setOptimisticDeletes((current) => {
        if (!current.has(fileId)) return current
        const next = new Set(current)
        next.delete(fileId)
        return next
      })
      return
    }

    // The outbox is authoritative. Local project cache cleanup is best-effort
    // and must not roll back an event that is already queued for the server.
    try {
      await patchProject(project.id, (p) => deleteFile(p, fileId))
    } catch (e) {
      console.warn("[delete] local project cache cleanup failed", e)
    }

    refresh()
    if (activeFileId === fileId) setActiveFileId(null)
    if (trashOpen) void refreshDeletedFiles()
  }, [project, currentUsername, refresh, activeFileId, setActiveFileId, trashOpen, refreshDeletedFiles])

  // Restore a soft-deleted file: emit file.restore, then refresh listings.
  const handleRestoreFile = useCallback(async (fileId: string) => {
    if (!project) return
    try {
      await emitFileRestore({
        projectId: project.id,
        fileId,
        author: currentUsername,
      })
    } catch (e) {
      console.error("[restore] file.restore emit failed", e)
      return
    }
    // Un-hide the row if it was soft-deleted this session — the optimistic
    // delete overlay would otherwise keep masking the restored file.
    setOptimisticDeletes((current) => {
      if (!current.has(fileId)) return current
      const next = new Set(current)
      next.delete(fileId)
      return next
    })
    refresh()
    void refreshDeletedFiles()
  }, [project, currentUsername, refresh, refreshDeletedFiles])

  // "Delete forever" — hard-delete via the existing REST endpoint (R2 wipe).
  // Only available from the trash UI (after the file is already soft-deleted).
  const handlePurgeFile = useCallback(async (fileId: string) => {
    if (!project) return
    void deleteFileProjection({
      jwt: frontierSession?.jwt ?? null,
      projectId: project.id,
      fileId,
    })
    void refreshDeletedFiles()
  }, [project, frontierSession, refreshDeletedFiles])

  const handleApplySuggestions = useCallback(async (chosen: RenameSuggestion[]) => {
    if (!project || chosen.length === 0) return
    // AQU-374: only act on suggestions that actually change something. A no-op
    // (name and corpus already match) must not flash the "Applied renames."
    // success toast — that was the reported "runs to success but renames nothing".
    const effective = chosen.filter(hasEffectiveChange)
    if (effective.length === 0) return
    const next = applySuggestions(project, effective)
    // Optimistic: surface new labels instantly and drop applied files from the banner.
    setOptimisticRenames((current) => {
      const map = new Map(current)
      for (const s of effective) map.set(s.fileId, s.suggestedName)
      return map
    })
    setClientProject(next)
    // Persist corpus/originalName locally (server file.rename only carries name).
    await updateProject(next)
    const nameChanges = effective.filter((s) => s.currentName !== s.suggestedName)
    if (nameChanges.length > 0) {
      try {
        await Promise.all(
          nameChanges.map((s) =>
            emitFileRename({
              projectId: project.id,
              fileId: s.fileId,
              name: s.suggestedName,
              author: currentUsername,
            }),
          ),
        )
      } catch (e) {
        // AQU-374: a failed enqueue must not masquerade as success. Roll back the
        // optimistic overlay + local record and surface the error instead of
        // showing the "Applied renames." toast.
        console.error("[rename] file.rename emit failed during suggestion apply", e)
        setOptimisticRenames((current) => {
          const map = new Map(current)
          for (const s of effective) map.delete(s.fileId)
          return map
        })
        setClientProject(project)
        void updateProject(project)
        refresh()
        alert(e instanceof Error ? `Rename failed: ${e.message}` : "Rename failed")
        return
      }
    }
    refresh()
    setUndo({ chosen: effective })
    setTimeout(() => setUndo((u) => (u?.chosen === effective ? null : u)), 10000)
  }, [project, currentUsername, refresh])

  const handleApplyOneSuggestion = useCallback(async (fileId: string) => {
    if (!project) return
    const target = suggestions.find((s) => s.fileId === fileId)
    if (!target) return
    await handleApplySuggestions([target])
  }, [project, suggestions, handleApplySuggestions])

  const handleRenameCorpus = useCallback(async (oldMarker: string, newMarker: string) => {
    if (!project) return
    await patchProject(project.id, (p) => renameCorpus(p, oldMarker, newMarker))
    refresh()
  }, [project, refresh])

  const handleDismissBanner = useCallback(async () => {
    setSuggestionsDismissed(true)
    if (!project) return
    const dismissedAt = new Date().toISOString()
    const next = { ...project, suggestionsDismissedAt: dismissedAt }
    setClientProject(next)
    await updateProject(next)
  }, [project])

  const handleReinviteSuggestions = useCallback(async () => {
    setSuggestionsDismissed(false)
    if (!project) return
    const next = { ...project }
    delete next.suggestionsDismissedAt
    setClientProject(next)
    await updateProject(next)
  }, [project])

  // FRO-177 (orchestrator glue): apply Replace-mode diffs through the standard
  // target-commit path — optimistic patch first for visible rows (write-clock
  // keeps own writes authoritative), then one outbox flush for the batch.
  const handleReplaceAll = useCallback(async (payload: ReplaceAllPayload) => {
    if (!project?.id || isReadOnly) return
    const touched: string[] = []
    for (const diff of payload.diffs) {
      const cell = getActiveCell(diff.cellId)
      if (!cell) continue
      if (cell.fileId === activeFileId) applyOptimisticTargetEdit(cell.id, { value: diff.after })
      const parentId = resolveTargetCommitParentId(cell)
      const eventId = await emitTargetCellCommit({
        projectId: project.id,
        fileId: cell.fileId,
        cellId: cell.id,
        parentId,
        sourceEventId: cell.sourceEventId ?? null,
        value: diff.after,
        author: currentUsername,
        targetLang: activeLane, // AQU-538: '' omitted on the wire by the emit
        searchQuery: payload.findQuery,
        replaceString: payload.replaceQuery,
      })
      rememberPendingTargetCommit(cell.id, eventId, parentId)
      touched.push(cell.id)
    }
    if (touched.length === 0) return
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    revalidateAuditStats()
    for (const id of touched) {
      if (getActiveCell(id)?.fileId === activeFileId) revalidateCell(id)
    }
    rebuildSearchIndex()
  }, [project?.id, isReadOnly, getActiveCell, activeFileId, applyOptimisticTargetEdit, activeLane, resolveTargetCommitParentId, rememberPendingTargetCommit, currentUsername, getTokenForProjectFile, refreshOutboxPending, revalidateAuditStats, revalidateCell, rebuildSearchIndex])

  const projectNavItems = useMemo(() => {
    // AQU-353: mirror the header lens toggle's label/icon exactly (see the
    // "voice-studio" item below).
    const audioLensTimeOrdered = activeFile ? fileOrderedBy(activeFile) === "time" : false
    const items = [
      { id: "rules", label: "Rules", icon: Scale,
        onClick: () => navigate(`/project/${projectId}/rules`) },
      { id: "terminology", label: "Terminology", icon: BookOpen,
        onClick: () => navigate(`/project/${projectId}/terminology`) },
      // Pinned: Comments carries a live unread count, so it stays visible;
      // everything unpinned collapses into the sidebar "More" menu.
      { id: "comments", label: "Comments", icon: MessagesSquare, pinned: true,
        badge: Array.from(openCommentCount.values()).reduce((a, b) => a + b, 0),
        onClick: () => navigate(`/project/${projectId}/comments`) },
      { id: "living-memory", label: "Memory", icon: BookMarked,
        onClick: () => navigate(`/project/${projectId}/memory`) },
      // AQU-353: this sidebar entry toggles the SAME Text/Audio lens as the
      // header segmented control (EditorModeToggle). It used to be labelled
      // "Voice" with the Mic2 icon while the header said "Audio", so testers hit
      // what looked like two different destinations. Both now read the canonical
      // label/icon from the shared audio-lens helper so they can't drift apart
      // ("Audio"/Mic2 for cell files, "Media"/AudioWaveform for time-ordered).
      //
      // NB: whether a nav *button* toggling a view mode (rather than navigating)
      // is the right interaction is a separate open question tracked with the
      // sidebar rework (FRO-308); this change only unifies the naming.
      { id: "voice-studio", label: audioLensLabel(audioLensTimeOrdered), icon: audioLensIcon(audioLensTimeOrdered),
        onClick: () => {
          const next = lens === "audio" ? "text" : "audio"
          setLens(next)
          // The Voices panel now lives in its own dock tab — surface it when
          // entering the Audio lens; fall back to Files when leaving.
          setDockTab(next === "audio" ? "voices" : "files")
        } },
      { id: "share", label: "Share", icon: Share2,
        onClick: () => setShareOpen(true) },
      { id: "settings", label: "Settings", icon: SettingsIcon,
        onClick: () => {
          if (!projectId) return
          window.location.assign(buildProjectSettingsHandoffUrl({
            projectId,
            returnTo: workspaceReturnPath(projectId, activeFileId),
          }))
        } },
      // FRO-272: trash moved out of the always-visible files footer into the
      // "More" menu — it opens a dialog now (project_lead+ only).
      ...(currentRoleLevel >= ROLE.PROJECT_LEAD
        ? [{ id: "trash", label: "Recently deleted", icon: Trash2,
            onClick: () => setTrashOpen(true) }]
        : []),
    ]
    return items
  }, [projectId, activeFileId, activeFile, navigate, openCommentCount, lens, setLens, setDockTab, currentRoleLevel])

  // Phase 2c-gamma: countTranscribeTargets/countSynthTargets lived in bulk-audio
  // (Y.Doc-coupled). They're zeroed until the audio-attachment event grammar
  // lands; the "Transcribe all" / "Synth all" menu items can still render.
  const audioCounts = useMemo(() => ({ untranscribed: 0, unsynthesized: 0 }), [])

  // Eager media strategy: prefetch every recording's waveform peaks into the
  // OPFS cache once the file is open, so even cells the user hasn't scrolled
  // to yet will have an instant waveform.
  useEffect(() => {
    if (project?.audioMediaStrategy !== "eager") return
    if (!frontierSession?.jwt) return
    if (cellSummaries.length === 0) return
    let cancelled = false
    const cells = readAtVersion(cellStoreVersion, getActiveCells)
    void eagerlyPrefetchPeaks({
      cells, project, session: frontierSession, bins: 320,
      isCancelled: () => cancelled,
    })
    return () => { cancelled = true }
  }, [project, cellSummaries.length, cellStoreVersion, frontierSession, getActiveCells])

  const actionCtx = useMemo(() => ({
    project: project!,
    activeFileId,
    fileProgress,
    canExportByOrgPolicy,
    audioCounts,
  }), [project, activeFileId, fileProgress, canExportByOrgPolicy, audioCounts])

  const openImportFlow = useCallback(() => {
    if (!project) return
    setImportOpen(true)
  }, [project])

  const openExportFlow = useCallback(() => {
    // FRO-253 (b fix): do NOT fire the action on an optimistic pre-fetch canExport value.
    // The button may render optimistically (canExport=true before settings load) but the
    // ACTION must wait until org settings have been fetched so we gate on the real floor.
    if (!orgSettingsFetched) return
    // AQU-253 (revised): open even when org policy disallows export — the
    // dialog renders an explicit permission gate with a help link instead of
    // silently no-opping, so users can see WHY export is unavailable.
    setExportOpen(true)
  }, [orgSettingsFetched])

  const actionArgs = useMemo(() => ({
    openImport: openImportFlow,
    runCompletions: () => {
      if (!activeFileId || !project) return
      const cells = getActiveCells()
      const untranslated = cells.filter((c) => !c.translated.trim())
      if (untranslated.length === 0) return
      // AQU-586: honor the project's configured completion batch size (default 10).
      completeBatch(untranslated.slice(0, completionBatchSizeFor(project)))
    },
    runCompleteAll: () => {
      if (!activeFileId) return
      const cells = getActiveCells()
      const untranslated = cells.filter((c) => !c.translated.trim())
      if (untranslated.length === 0) return
      // No slice — draft every untranslated cell; useCompletion chunks internally.
      completeBatch(untranslated)
    },
    runExport: openExportFlow,
    // FRO-288: wire batch-validate through the real validation event path.
    // Called AFTER the user confirms via PrimaryActionButton's confirmation
    // dialog (requiresConfirmation in registry.ts). Role floor is enforced
    // server-side; we mirror-check here to avoid queueing guaranteed-403
    // events (same pattern as emitValidationChange in EditorTable).
    runBatchValidate: () => {
      if (!project?.id || !activeFileId) return
      if (!canPerform("cell.validate", project.syncRole?.level ?? null)) return
      const eligible = cellSummaries.filter(
        (c) => c.fileId === activeFileId && isBulkValidationEligible(c),
      )
      // AQU-586: cap how many eligible cells one batch-validate processes.
      // 0/undefined = validate all eligible (unchanged default behavior).
      const cap = project.completionSettings?.validationBatchSize
      const validatable =
        typeof cap === "number" && cap > 0 ? eligible.slice(0, cap) : eligible
      if (validatable.length === 0) return
      void (async () => {
        for (const cell of validatable) {
          await emitCellValidate({
            projectId: project.id,
            fileId: cell.fileId,
            cellId: cell.id,
            editEventId: cell.targetEventId!,
            author: currentUsername,
            targetLang: activeLane, // AQU-538: '' omitted on the wire by the emit
          })
        }
        await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
        await refreshOutboxPending()
        revalidateAuditStats()
        for (const cell of validatable) revalidateCell(cell.id)
      })()
    },
    runAgentInput: () => {
      console.info("agent-input triggered (placeholder runner)")
    },
    runImportIntoFile: () => {
      if (!activeFileId) return
      setFileImportOpen(true)
    },
    runTranscribeAll: () => {
      if (!activeFileId || !project) return
      const cells = getActiveCells()
      void runBatchTranscribeAll({
        cells,
        projectId: project.id,
        session: frontierSession ?? null,
        language: project.sourceLanguage,
      })
    },
    runSynthAll: () => {
      if (!activeFileId || !project) return
      const cells = getActiveCells()
      void runBatchSynthAll({
        cells,
        project,
        session: frontierSession ?? null,
        username: currentUsername,
      })
    },
    navigate,
  }), [activeFileId, completeBatch, getActiveCells, cellSummaries, project, frontierSession, currentUsername, activeLane, navigate, openImportFlow, openExportFlow, getTokenForProjectFile, refreshOutboxPending, revalidateAuditStats, revalidateCell])

  const timelineEditorVisible =
    cellAreaState.kind === "ready" &&
    lens === "audio" &&
    Boolean(activeFile && fileOrderedBy(activeFile) === "time")
  const legacyCellsNeeded =
    centerSurface === "rules" ||
    dockTab === "voices" ||
    timelineEditorVisible ||
    lens === "audio" ||
    drawerRuleId !== null ||
    recordingCellId !== null ||
    exportOpen ||
    checkOpen
  const legacyCells = useMemo(
    () => legacyCellsNeeded ? readAtVersion(cellStoreVersion, getActiveCells) : EMPTY_CELL_DATA,
    [cellStoreVersion, getActiveCells, legacyCellsNeeded],
  )

  const handleCellCommitted = useCallback(async (cellId?: string, committedEventId?: string, parentId?: string | null) => {
    if (cellId && committedEventId) {
      rememberPendingTargetCommit(cellId, committedEventId, parentId ?? null)
    }
    // Capture before async work — another edit could arrive during the flush.
    const pendingEdit = lastOptimisticEditRef.current
    lastOptimisticEditRef.current = null

    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    // Targeted: a hand edit / validate / waive touches exactly one cell. Pull
    // only that row's stats and cell data instead of re-fetching the whole
    // file. Fall back to a full revalidate if the caller didn't pass a
    // cellId (older call sites).
    const changed = cellId ?? pendingEdit?.cellId
    if (changed) {
      revalidateCellStats(changed)
      revalidateCell(changed)
    } else {
      revalidateAuditStats()
      revalidateCells()
    }
  }, [getTokenForProjectFile, rememberPendingTargetCommit, refreshOutboxPending, revalidateAuditStats, revalidateCellStats, revalidateCell, revalidateCells])

  // AQU-616: bulk validate/unvalidate from the SelectionBar enqueues N events
  // but has no per-cell commit callback, so without this the events would wait
  // for the ~5s periodic flusher before syncing — the confirmed state lags for
  // seconds. Flush + revalidate immediately, mirroring handleCellCommitted and
  // the "validate all" workspace action.
  const handleBulkValidationCommitted = useCallback(async () => {
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    revalidateAuditStats()
    revalidateCells()
  }, [getTokenForProjectFile, refreshOutboxPending, revalidateAuditStats, revalidateCells])

  const workspaceHeaderMenuItems = useMemo((): OverflowMenuItem[] => {
    const diarizeLabel =
      diarizePhase === "starting" || diarizePhase === "running"
        ? "Diarizing…"
        : diarizePhase === "applying"
          ? "Applying…"
          : diarizeError
            ? "Diarize failed"
            : "Diarize"

    const items: OverflowMenuItem[] = [
      {
        id: "view-settings",
        label: "View settings",
        icon: Eye,
        onClick: () => viewSettingsRef.current?.open(),
      },
      {
        id: "next-unfinished",
        label: "Next unfinished",
        icon: ArrowRight,
        disabled: !activeFileId || !hasUnfinished,
        onClick: handleJumpNextUnfinished,
      },
    ]

    // Export intentionally absent here — it lives in the primary-action
    // dropdown (workspace-actions registry), and duplicating it was noise.

    if (canAssignWork && activeFileId) {
      items.push({
        id: "assign-work",
        label: "Assign work",
        icon: UserCheck,
        onClick: () => setAssignModalOpen(true),
      })
    }

    if (lens === "audio" && canDiarize) {
      items.push({
        id: "diarize",
        label: diarizeLabel,
        icon: Users,
        disabled: diarizeBusy,
        onClick: handleDiarize,
      })
    }

    const contextual: OverflowMenuItem[] = [
      ...(isSubtitleFile
        ? [{
            id: "attach-video",
            label: "Attach video",
            icon: Film,
            onClick: () => setVideoDialogOpen(true),
          }]
        : []),
      ...(suggestions.length > 0 && (suggestionsDismissed || project?.suggestionsDismissedAt)
        ? [{
            id: "redetect-suggestions",
            label: `Show ${suggestions.length} file name suggestion${suggestions.length === 1 ? "" : "s"}`,
            icon: Sparkles,
            onClick: handleReinviteSuggestions,
          }]
        : []),
    ]

    if (contextual.length > 0) {
      items.push({ id: "sep-contextual", type: "separator" })
      items.push(...contextual)
    }

    return items
  }, [
    activeFileId,
    hasUnfinished,
    handleJumpNextUnfinished,
    canAssignWork,
    lens,
    canDiarize,
    diarizePhase,
    diarizeError,
    diarizeBusy,
    handleDiarize,
    isSubtitleFile,
    suggestions.length,
    suggestionsDismissed,
    project?.suggestionsDismissedAt,
    handleReinviteSuggestions,
  ])

  if (status === "loading") return <WorkspaceSkeleton />
  if (status === "no-session") {
    return (
      <div className="p-8 text-muted-foreground">
        This project isn't on this device. <button className="underline" onClick={goToProjects}>Sign in</button> to open it from the cloud.
      </div>
    )
  }
  // RES-5: distinguish server-unreachable from a genuinely missing project.
  // A 5xx / network error means the project *may* exist — show a retry CTA
  // rather than the misleading "not found" message.
  if (status === "unreachable") {
    return (
      <div className="p-8">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <span className="text-amber-800 dark:text-amber-200">
            Can't reach the server — your project may still be available.
          </span>
          <button
            type="button"
            onClick={refresh}
            className="shrink-0 rounded-md bg-amber-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }
  // FRO-346: revoked / never-granted access gets its own clean state — the
  // project exists, so "not found" would be misleading (and after a member
  // removal the removed user must land here on reload, not in the editor).
  if (status === "forbidden") {
    return (
      <div className="p-8 text-muted-foreground" data-testid="project-no-access">
        You no longer have access to this project. Ask a project maintainer to
        re-invite you if this is unexpected.{" "}
        <button className="underline" onClick={goToProjects}>Back to dashboard</button>.
      </div>
    )
  }
  if (status === "not-found" || !project) {
    return (
      <div className="p-8 text-muted-foreground">
        Project not found, or you don't have access. <button className="underline" onClick={goToProjects}>Back to dashboard</button>.
      </div>
    )
  }

  if (project.deletedAt) {
    return (
      <TrashedProjectScreen
        project={project}
        onClose={goToProjects}
        onRestore={async () => {
          const result = await restoreProject(project, { jwt: frontierSession?.jwt ?? null })
          if (result.remote.kind === "forbidden" || result.remote.kind === "error") {
            return
          }
          refresh()
        }}
      />
    )
  }

  async function handleImported(
    refs: FileReference[],
    inferredLanguages?: { sourceLanguage?: string; targetLanguage?: string; explicit?: boolean },
  ) {
    if (!project) return
    // FRO-249 fix (Fix 2): serialize the read-modify-write through a module-level
    // promise chain so concurrent imports don't race on the project.files array.
    // Each call appends to _lastImportWrite; if the previous call fails the chain
    // still proceeds (catch → undefined) so one bad import can't wedge all future ones.
    // The chain resolves with the fresh baseProject so the language-seed block
    // below (which also needs a fresh read) can reuse it without a second IDB call.
    const projectSnapshot = project // capture before the await boundary
    _lastImportWrite = _lastImportWrite
      .catch(() => undefined) // absorb prior failures so the chain is never stuck
      .then(async () => {
        // WARN a fix: read fresh project state rather than the render-closure value —
        // imports can take minutes; a language set mid-import must not be clobbered.
        const localProject = await getProject(projectSnapshot.id).catch(() => undefined)
        const baseProject = localProject ?? projectSnapshot
        const nextFiles = [...baseProject.files]
        const seenFileIds = new Set(nextFiles.map((file) => file.id))
        for (const ref of refs) {
          if (seenFileIds.has(ref.id)) continue
          nextFiles.push(ref)
          seenFileIds.add(ref.id)
        }
        await updateProject({
          ...projectSnapshot,
          ...baseProject,
          sourceLanguage: projectSnapshot.sourceLanguage || baseProject.sourceLanguage,
          targetLanguage: projectSnapshot.targetLanguage || baseProject.targetLanguage,
          syncRole: projectSnapshot.syncRole ?? baseProject.syncRole,
          files: nextFiles,
        })
        return baseProject
      })
    // Await and capture baseProject for the language-seed block below.
    const baseProject = await _lastImportWrite
    // FRO-249: seed source/target language from import metadata.
    //
    // Two modes (determined by `inferredLanguages.explicit`):
    //   - EXPLICIT (user confirmed via DirectionPanel): values REPLACE current
    //     ones when the current target is empty OR equals the current source
    //     (the broken source==target state). This is BLOCKER 1's fix.
    //   - INFERRED (metadata-only, no explicit confirmation): only fills EMPTY
    //     slots, never overwrites an intentionally configured language.
    //
    // WARN a: use `baseProject` (freshly read above) for the emptiness test,
    //   not the stale render-closure `project`.
    //
    // WARN b: only attempt the settings PATCH when the caller's role meets the
    //   SERVER floor (MAINTAINER=600). Below that, patchSettings applies the
    //   change locally to IDB then 403s server-side, causing per-device language
    //   divergence. We skip the call entirely to avoid that split-brain.
    //   NOTE: EDIT_ROLE_FLOOR in useProjectSettings.ts is PROJECT_LEAD (500) —
    //   that mismatch vs the server's MAINTAINER (600) is a separate issue
    //   flagged for follow-up (see Linear comment on FRO-249).
    if (inferredLanguages && baseProject) {
      const { explicit, sourceLanguage: inSrc, targetLanguage: inTgt } = inferredLanguages
      // Read from baseProject (fresh) for the emptiness decision (WARN a).
      const currentSource = baseProject.sourceLanguage?.trim() || ""
      const currentTarget = baseProject.targetLanguage?.trim() || ""

      let newSource: string
      let newTarget: string

      if (explicit) {
        // BLOCKER 1: explicit answer from DirectionPanel wins.
        // Replace when current target is empty OR equals current source (broken state).
        const targetBroken = currentTarget === "" || languagesEqual(currentTarget, currentSource)
        newSource = (inSrc?.trim() || currentSource)
        newTarget = targetBroken
          ? (inTgt?.trim() || currentTarget)
          : currentTarget
      } else {
        // Inferred-only: fill empty slots only.
        newSource = currentSource || inSrc?.trim() || ""
        newTarget = currentTarget || inTgt?.trim() || ""
      }

      // Distinct source/target is the key invariant — skip if both would end
      // up as the same value (WARN e: use normalizer for comparison).
      const sourceDiffers = newSource !== currentSource
      const targetDiffers = newTarget !== currentTarget
      const resultDistinct = !languagesEqual(newSource, newTarget)

      if ((sourceDiffers || targetDiffers) && resultDistinct && (newSource || newTarget)) {
        const patch: Record<string, string> = {}
        if (sourceDiffers && newSource) patch.sourceLanguage = newSource
        if (targetDiffers && newTarget) patch.targetLanguage = newTarget

        if (Object.keys(patch).length > 0) {
          // WARN b fix: gate on the SERVER role floor (MAINTAINER=600) to prevent
          // the local-only half-apply when the server will 403 us anyway.
          const roleLevel = baseProject.syncRole?.level ?? 0
          const serverFloor = ROLE.MAINTAINER // 600
          if (roleLevel >= serverFloor) {
            void patchSettings(patch).then((outcome) => {
              if (outcome.kind !== "ok") {
                console.warn("[FRO-249] language seed returned non-ok:", outcome)
              }
            }).catch((err) => {
              console.warn("[FRO-249] failed to seed language settings after import:", err)
            })
          } else {
            // FRO-249/FRO-255 fix (Fix 4): surface this to the user — a silent
            // console.warn left the dialog implying success. The import itself
            // succeeded; only the project-wide language setting was skipped.
            console.warn(
              `[FRO-249] skipping language seed — role ${roleLevel} is below server floor ${serverFloor}. ` +
              "Mismatch note: EDIT_ROLE_FLOOR in useProjectSettings is PROJECT_LEAD(500) but server requires MAINTAINER(600); tracked for follow-up.",
            )
            setTransientNotice({
              message: "Direction applied locally only — saving project-wide needs a maintainer.",
              severity: "warning",
            })
          }
        }
      }
    }
    optimisticFileIdsRef.current = new Set([
      ...optimisticFileIdsRef.current,
      ...refs.map((ref) => ref.id),
    ])
    setOptimisticFiles((current) => {
      const seen = new Set(current.map((file) => file.id))
      const next = [...current]
      for (const ref of refs) {
        if (!seen.has(ref.id)) next.push(ref)
      }
      optimisticFileIdsRef.current = new Set(next.map((file) => file.id))
      return next
    })
    if (refs.length > 0) {
      workspaceTabs.openFile(refs[0].id)
      // AQU (mp3 "unusable" report): a media import has no text cells, so the
      // Text lens greets the user with "No text segments in this file" — which
      // reads as a failed import. Land them on the Media/Audio lens instead.
      if (isMediaFileType(refs[0].type)) setLens("audio")
    }
    // The bulk importer (lib/import.ts → POST /import) has already persisted
    // file.create + every source.cell.create server-side before resolving, so
    // there's nothing to flush — just pull the fresh projection in.
    refresh()
    revalidateCells()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <EditorScrollProvider>
      {/* ScrollToGroupHandler must live inside EditorScrollProvider so it can call useEditorScroll */}
      <ScrollToGroupHandler cellStore={cellStore} storeVersion={cellStoreVersion} editorRef={editorRef} />
      {/* FRO-308: currentCell for chat panel — derived from focusedCellId */}
      <AppShell
        railCollapsed={dockTab === null}
        logoAccessory={
          dockTab !== null ? (
            <AppTooltip content="Collapse sidebar" side="right">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Collapse sidebar"
                onClick={() => setDockTab(null)}
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </Button>
            </AppTooltip>
          ) : null
        }
        leftDock={
          <LeftDock
            storageKey={projectId}
            activeTab={dockTab}
            onActiveTabChange={(t) => {
              // While the workbench IS the agent surface, the dock's Agent tab
              // has nothing to show but a pointer back to it — a wide panel of
              // dead chrome beside the takeover. Make that state unreachable.
              if (t === "agent" && centerSurface === "agent") return
              setDockTab(t)
              // Opening the Voices tab puts the editor into the Audio lens so
              // the per-line voice controls show alongside the panel.
              if (t === "voices" && lens !== "audio") setLens("audio")
            }}
            voicesPanel={
              project ? (
                <div className="flex h-full min-h-0 flex-col overflow-hidden p-2">
                  <VoiceSidebar
                    cells={legacyCells}
                    project={audioProject ?? project}
                    projectId={project.id}
                    tts={tts}
                    session={frontierSession ?? null}
                    username={currentUsername}
                    targetLanguage={project.targetLanguage}
                    fileId={activeFileId}
                    cloneOpen={makeCharacterOpen}
                    onCloneOpenChange={(open) => {
                      setMakeCharacterOpen(open)
                      if (!open) setMakeCharacterSeedCellId(null)
                    }}
                    cloneSeedCellId={makeCharacterSeedCellId}
                  />
                </div>
              ) : undefined
            }
            filesPanel={
              <div className="flex h-full flex-col overflow-y-auto overflow-x-hidden">
                {lens !== "audio" && (
                  <SuggestionBanner
                    suggestions={bannerSuggestions}
                    onApply={handleApplySuggestions}
                    onDismiss={handleDismissBanner}
                  />
                )}
                <ExpandableFileList
                  projectId={projectId!}
                  files={project.files}
                  activeFileId={centerSurface === "agent" ? (agentScopeFile?.id ?? activeFileId) : activeFileId}
                  fileProgress={fileProgress}
                  suggestionFileIds={suggestionFileIds}
                  validationCount={validationCount}
                  getTokenForFile={getTokenForFile}
                  onSelectFile={(fileId, opts) => {
                    // Workbench: the explorer designates the agent's working
                    // area — stay in the takeover, retarget the session, and
                    // let the model hear about it on the next turn.
                    if (centerSurface === "agent") {
                      setAgentScopeFileId(fileId)
                      const name = projectFiles.find((f) => f.id === fileId)?.name ?? fileId
                      if (project?.id) {
                        agentSessionStore(project.id).noteActivity(
                          "scope",
                          `The user set the working area to the file "${name}" (:file now resolves to it).`,
                        )
                      }
                      return
                    }
                    workspaceTabs.openFile(fileId, opts)
                  }}
                  onRename={handleRename}
                  onMove={(fileId) => {
                    setMoveTargetId(fileId)
                    setMoveCorpus(project.files.find((f) => f.id === fileId)?.corpusMarker ?? "")
                  }}
                  onDelete={currentRoleLevel >= ROLE.PROJECT_LEAD ? (fileId) => setPendingDeleteId(fileId) : undefined}
                  onApplySuggestion={handleApplyOneSuggestion}
                  onRenameCorpus={handleRenameCorpus}
                  canExportByOrgPolicy={canExportByOrgPolicy}
                  onOpenGlossary={() => navigate(`/project/${projectId}/terminology`)}
                  glossaryActive={centerSurface === "terminology"}
                />
                <SidebarProjectSection items={projectNavItems} />
                {/* FRO-192: member's per-project assignment pickup panel. */}
                {project?.id && jwt && (
                  <ProjectAssignedToMe
                    projectId={project.id}
                    jwt={jwt}
                    onJumpToScopeLabel={jumpToScopeLabel}
                    refreshKey={assignmentsRefreshKey}
                  />
                )}
                {/* Contextual onboarding status — self-removes once setup
                    completes. Sidebar-footer placement (Linear-style) keeps
                    transient onboarding state out of the action header. The
                    account switcher now lives in the dock footer (LeftDock) so
                    it's present in every tab, not just this Files panel. */}
                {checklistState.totalCount > 0 && checklistState.completedCount < checklistState.totalCount && (
                  <div className="mt-auto border-t px-2 pb-2 pt-2">
                    <Tooltip open={showChipTooltip} onOpenChange={setShowChipTooltip}>
                      <TooltipTrigger
                        render={
                          <button
                            onClick={() => { setShowChipTooltip(false); setChecklistOpen(true) }}
                            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                          />
                        }
                      >
                        <ClipboardList className="h-3 w-3" />
                        Setup: {checklistState.completedCount}/{checklistState.totalCount}
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        Reopen the setup checklist anytime from here.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>
            }
            agentPanel={
              <AgentDockPanel
                currentCell={(() => {
                  if (!focusedCellId) return null
                  const cell = getActiveCell(focusedCellId)
                  if (!cell) return null
                  return {
                    sourceText: cell.original,
                    translatedText: cell.translated,
                    context: cell.context ?? undefined,
                  }
                })()}
                agent={{
                  projectId: project.id,
                  jwt,
                  author: currentUsername,
                  roleLevel: currentRoleLevel,
                  context: {
                    fileId: activeFileId ?? undefined,
                    cellId: focusedCellId ?? undefined,
                  },
                  fileName: activeFile?.name,
                  rules,
                  resolveCell: resolveCellById,
                  onApplied: handleAgentApplied,
                }}
                bibleSummary={bibleSummary}
                pendingChip={pendingChip}
                onPendingChipConsumed={() => setPendingChip(null)}
                onExpand={() => navigate(`/project/${projectId}/agent`)}
                expanded={centerSurface === "agent"}
              />
            }
            searchPanel={
              <SearchDockPanel
                activeFileId={activeFileId}
                activeFileName={activeFileId ? project.files.find((f) => f.id === activeFileId)?.name ?? null : null}
                loading={searchLoading}
                ready={searchReady}
                results={searchResults}
                onReady={buildIndex}
                onSearch={(q, opts) => void runSearch(q, opts)}
                onSearchPassages={runSearchPassages}
                onClearResults={clearSearchResults}
                onSelect={handleSearchSelect}
                isReadOnly={isReadOnly}
                onAfterReplace={rebuildSearchIndex}
                onReplaceAll={handleReplaceAll}
                onOpenFullPanel={() => {
                  setParallelMode("search")
                  setParallelScope(activeFileId ? "file" : "project")
                  setParallelOpen(true)
                }}
                onExpandResults={(q) => setSearchExpandedQuery(q)}
                bibleResourcesEnabled={resolveBibleResourcesEnabled(
                  project.bibleResourcesEnabled,
                  projectHasScriptureFiles(project.files),
                )}
                projectId={project.id}
                getJwt={() => jwtRef.current}
                canonicalRef={focusedCellCanonicalRef}
              />
            }
          />
        }
        header={
          <WorkspaceHeader
            project={project}
            extraMenuItems={workspaceHeaderMenuItems}
            overviewHref={projectId ? `/projects/${projectId}` : undefined}
            surfaceLabel={workspaceBreadcrumb.surfaceLabel}
          >
            {/* AQU-615: Door43 upstream-sync badge — visible hint that source
                cells are managed by a DCS link. Self-gated: renders nothing
                when project_settings has no dcsUpstream cursor. */}
            {project && projectId && (
              <DcsSyncBadgeMount
                projectId={projectId}
                roleLevel={serverRoleLevel}
                onClick={() => navigate(`/project/${projectId}/settings`)}
              />
            )}

            {project && centerSurface === "rules" && (
              <>
                <Button variant="outline" size="sm" onClick={() => navigate(`/project/${projectId}/terminology`)}>
                  <BookOpen data-icon="inline-start" />
                  Terminology
                </Button>
                <RuleImportDialog
                  completionSettings={project.completionSettings}
                  onAdd={addRule}
                  projectId={projectId!}
                />
                <RuleSuggestFromEditsDialog
                  completionSettings={project.completionSettings}
                  onAdd={addRule}
                  projectId={projectId!}
                  cells={legacyCells}
                />
                <Button
                  size="sm"
                  onClick={() => setEditingRuleId("new")}
                  disabled={editingRuleId !== null}
                >
                  + Add Rule
                </Button>
              </>
            )}

            {project && centerSurface === "editor" && activeFileId ? (
              <>
                {/* AQU-602: the active-lane switcher moved into the editor's
                    TARGET language tag (see EditorTable header) — no separate
                    header control. */}
                <EditorModeToggle
                  lens={lens}
                  onChange={(l) => {
                    setLens(l)
                    // Surface the Voices tab when entering the Audio lens.
                    if (l === "audio") setDockTab("voices")
                  }}
                  timeOrdered={activeFile ? fileOrderedBy(activeFile) === "time" : false}
                />
              </>
            ) : null}

            {/* Phase 0.5: deterministic "Check file" entry point. Title doubles
                as the last-run summary so the result is visible at the button. */}
            {project && centerSurface === "editor" && activeFileId && (
              <button
                type="button"
                onClick={() => void runCheck()}
                disabled={checkRunning}
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent disabled:opacity-60"
                title={
                  checkResult
                    ? `Last check: ${checkResult.totalFindingCount} issue${checkResult.totalFindingCount === 1 ? "" : "s"} · ${checkScopeSummary(checkResult)} · ${new Date(checkResult.ranAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
                    : "Check the open file against the project's rules and term base"
                }
                aria-label="Check file"
                data-testid="check-file-button"
              >
                {checkRunning
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <ListChecks className="h-3 w-3" />}
                Check file
                {checkResult && !checkRunning && (
                  <span className={checkResult.totalFindingCount > 0
                    ? "rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-300"
                    : "rounded-full bg-green-100 px-1.5 text-[10px] font-semibold text-green-800 dark:bg-green-900/50 dark:text-green-300"}>
                    {checkResult.totalFindingCount}
                  </span>
                )}
              </button>
            )}

            <PrimaryActionButton ctx={actionCtx} run={actionArgs} />

            {/* FRO-331: hidden trigger — opened from ⋯ menu; keeps RTL hint anchored here. */}
            <ViewSettingsMenu
              ref={viewSettingsRef}
              hideTrigger
              fileOpen={Boolean(activeFileId)}
              lineNumbersEnabled={fileMeta.lineNumbersEnabled}
              sourceDirectionMode={fileMeta.sourceDirectionMode}
              targetDirectionMode={fileMeta.targetDirectionMode}
              sourceTextDirection={fileMeta.sourceTextDirection}
              targetTextDirection={fileMeta.targetTextDirection}
              sourceAutoDirectionSummary={activeFileDirectionSummary.source}
              targetAutoDirectionSummary={activeFileDirectionSummary.target}
              directionWarningScope={activeFile?.id ?? null}
              cellLabelsEnabled={cellLabelsEnabled}
              footnoteViewMode={footnoteViewMode}
              onFootnoteViewModeChange={setFootnoteViewMode}
              tnSidebarEnabled={tnSidebarVisible}
              sourceFontSize={fontSizes.source}
              targetFontSize={fontSizes.target}
              onLineNumbersChange={fileMeta.setLineNumbersEnabled}
              onSourceDirectionModeChange={fileMeta.setSourceDirectionMode}
              onTargetDirectionModeChange={fileMeta.setTargetDirectionMode}
              onCellLabelsChange={setCellLabelsEnabled}
              onSourceFontSizeChange={(v) => { if (activeFileId) setFileViewPref(activeFileId, { sourceFontSize: v }) }}
              onTargetFontSizeChange={(v) => { if (activeFileId) setFileViewPref(activeFileId, { targetFontSize: v }) }}
              onTnSidebarChange={(v) => {
                setTnSidebarVisible(v)
                if (projectId) writeTnSidebarVisible(projectId, v)
              }}
            />
          </WorkspaceHeader>
        }
        aboveCard={
          // Agent workbench is a takeover surface — file tabs stay with the editor.
          centerSurface === "agent" ? null :
          <TabStrip
            tabs={workspaceTabs.tabs}
            // While a non-editor surface (Rules) is showing, no file tab is
            // "active" even though selectedFileId still remembers the last
            // file — the surface tab is the active one.
            activeTabId={centerSurface === "editor" ? workspaceTabs.activeTabId : null}
            files={projectFiles}
            onActivate={workspaceTabs.activateTab}
            onClose={handleCloseTab}
            surfaceTab={
              centerSurface === "rules" && projectId
                ? {
                    label: "Rules",
                    // Navigating to the bare project route lets the
                    // restore-location effect re-open the last active file.
                    onClose: () => navigate(`/project/${projectId}`),
                  }
                : null
            }
          />
        }
        beforeMain={
          <>
{/* Agent workbench is a takeover surface: the selection bar belongs
                to the editor and only adds competing chrome above the workbench.
                Banners below still render. */}
            {project && activeFileId && centerSurface !== "agent" && (
              <>
                <SelectionBar
                  project={project}
                  cellStore={cellStore}
                  session={frontierSession}
                  username={currentUsername}
                  completeSingle={completeSingle}
                  completeBatch={completeBatch}
                  onValidationCommitted={handleBulkValidationCommitted}
                  audioMode={lens === "audio"}
                  onVoiceTogether={async (sel) => {
                    if (!activeFileId || !project) return
                    const result = await generateCombinedVoice({
                      project,
                      fileId: activeFileId,
                      cells: sel,
                      settings: tts.settings,
                      session: frontierSession,
                      username: currentUsername,
                    })
                    revalidateCells()
                    // Open the manual divider editor to set per-line slices.
                    setCombinedEditor(result)
                  }}
                />
              </>
            )}
            {isReadOnly && (
              <div className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-900">
                <Lock className="h-3.5 w-3.5" />
                Read-only — imported from git. Push is coming in Phase 2.
              </div>
            )}
            {project && (
              <SystemPromptNudge
                project={project}
                onProjectUpdated={handleProjectUpdated}
                onCustomize={() => setChecklistOpen(true)}
              />
            )}
            {/* FRO-214 (orchestrator glue): frozen-project banner — surfaces the
                reactivate affordance instead of letting edits through. */}
            {isFrozen && project && (
              <InactiveProjectBanner
                projectName={project.name}
                canReactivate={(project.syncRole?.level ?? 0) >= 500}
                busy={lifecycleBusy}
                onReactivate={() => { const j = jwtRef.current; if (j) void toggleLifecycle(j) }}
              />
            )}
            {/* FRO-296: offline banner — shown when browser reports no connectivity. */}
            <OfflineBanner />
            {/* FRO-235: AI completion progress + stop control */}
            <div className="px-3 py-1 empty:hidden">
              <CompletionBulkProgressBanner />
            </div>
            {isSubtitleFile && videoSrc && centerSurface !== "agent" && (
              <ResizableVideoPanel>
                {(height) => (
                  <VideoPlayer
                    ref={videoPlayerRef}
                    src={videoSrc}
                    cues={videoCues}
                    startOffset={videoStartOffset}
                    height={height}
                    onTimeUpdate={setCurrentVideoTime}
                  />
                )}
              </ResizableVideoPanel>
            )}
            {isSubtitleFile && blobUnavailable && !videoAttachment.videoUrl && (
              <div className="bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                Video file not available on this device. Attach it locally or paste a URL via the Film icon.
              </div>
            )}
            {/* F6: stale-sibling dead-letter banner. Clicking "View in
                history" routes to the affected cell's history drawer where
                the stale commit is preserved as a branch off its parent and
                can be promoted (per the AD-2 recovery flow). When several
                edits lost their race in the same flush we jump to the first
                one — multi-conflict triage is out of scope for now. */}
            {showStaleSiblingBanner && (
              <div className="flex items-center justify-between gap-2 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <span>
                  {outboxStaleSiblingCount === 1
                    ? "1 change was rejected because it conflicted with a newer edit from another session."
                    : `${outboxStaleSiblingCount} changes were rejected because they conflicted with newer edits from another session.`}
                </span>
                <div className="ml-2 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const first = outboxStaleSiblingEntries.find(
                        (e) => e.cellId && e.fileId,
                      )
                      if (first?.cellId && first.fileId) {
                        if (first.fileId !== activeFileId) {
                          setActiveFileId(first.fileId)
                        }
                        setDrawerRuleId(null)
                        setCommentsCellId(null)
                        setHistoryCellId(first.cellId)
                      }
                      clearStaleSiblings()
                    }}
                    className="rounded bg-amber-200/60 px-2 py-0.5 hover:bg-amber-200 dark:bg-amber-800/50 dark:hover:bg-amber-800"
                  >
                    View in history
                  </button>
                  <button
                    type="button"
                    onClick={clearStaleSiblings}
                    className="rounded bg-amber-200/40 px-2 py-0.5 hover:bg-amber-200 dark:bg-amber-800/30 dark:hover:bg-amber-800"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {/* F5: stale-source pin banner */}
            {showStaleSourceBanner && (
              <div className="flex items-center justify-between gap-2 bg-blue-50 px-4 py-2 text-xs text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                <span>Source text changed since your last edit — your translation was saved, but please re-confirm it reflects the latest source.</span>
                <button
                  type="button"
                  onClick={() => setStaleSourceBannerDismissed(outboxStaleSourceCount)}
                  className="ml-2 rounded bg-blue-200/60 px-2 py-0.5 hover:bg-blue-200 dark:bg-blue-800/50 dark:hover:bg-blue-800"
                >
                  Dismiss
                </button>
              </div>
            )}
            {/* FRO-274: BT write-failure banner — shown when the BT persist
                outbox enqueue fails. The user must copy their work before
                reloading since the in-memory cache won't survive a reload
                once localStorage quota is hit. */}
            {btWriteError && (
              <div
                role="alert"
                aria-live="assertive"
                className="flex items-center justify-between gap-2 bg-destructive/10 px-4 py-2 text-xs text-destructive dark:bg-destructive/20"
              >
                <span>{btWriteError}</span>
                <button
                  type="button"
                  onClick={() => setBtWriteError(null)}
                  className="ml-2 rounded bg-destructive/20 px-2 py-0.5 hover:bg-destructive/30"
                >
                  Dismiss
                </button>
              </div>
            )}
            {/* FRO-288: focus-lock takeover banner — shown when another user
                claims the cell we are currently editing. The cell becomes
                read-only via lockHolderLabel; this banner makes the takeover
                VISIBLE so the user knows their in-flight edit was not saved
                and can copy their text before moving away. Without this the
                only signal was a console.warn inside handleEditorCommit. */}
            {focusLockState.heldBy && focusedCellId && (
              <div
                role="alert"
                aria-live="assertive"
                className="flex items-center justify-between gap-2 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              >
                <span>
                  {focusLockState.heldBy.userId} is now editing this cell — your editor is read-only. Copy any unsaved text before moving away.
                </span>
              </div>
            )}
          </>
        }
        main={centerSurface === "rules" ? (
          // FRO-194: Rules surface renders inside the shell; shell stays mounted.
          <RulesSurface
            project={project}
            projectId={projectId!}
            userRules={userRules}
            builtinRules={builtinRules}
            addRule={addRule}
            updateRule={updateRule}
            deleteRule={deleteRule}
            setBuiltinOverride={setBuiltinOverride}
            infractions={infractions}
            cells={legacyCells}
            orgRules={orgRules}
            canEditOrgRules={canEditOrgSettings}
            patchOrgSettings={patchOrgSettings}
            orgSettingsVersion={orgSettingsVersion}
            promotionRequests={promotionRequests}
            canRequestPromotion={canRequestPromotion}
            requestPromotion={requestPromotion}
            editingRuleId={editingRuleId}
            setEditingRuleId={setEditingRuleId}
          />
        ) : centerSurface === "comments" ? (
          // FRO-254: Comments page inside the shell — back button in the page
          // navigates to /project/:id, which the restore-location effect turns
          // into the user's last open file (including scroll position).
          <div className="h-full overflow-y-auto">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading comments…</div>}>
              <CommentsPageContent />
            </Suspense>
          </div>
        ) : centerSurface === "memory" ? (
          // FRO-254: Living Memory page inside the shell.
          <div className="h-full overflow-y-auto">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading living memory…</div>}>
              <LivingMemoryPageContent />
            </Suspense>
          </div>
        ) : centerSurface === "terminology" ? (
          // FRO-254: Terminology page inside the shell.
          <div className="h-full overflow-y-auto">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading terminology…</div>}>
              <GlossaryEditorContent files={projectFiles} />
            </Suspense>
          </div>
        ) : centerSurface === "members" ? (
          // FRO-180: Per-project members management inside the shell.
          <div className="h-full overflow-y-auto">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading members…</div>}>
              <ProjectMembersPageContent />
            </Suspense>
          </div>
        ) : centerSurface === "agent" ? (
          // Agent workbench (agent-mode-v2 §4): full-screen agent surface —
          // same shared session as the dock tab, plus the working-set panel.
          <AgentWorkbench
            agent={{
              projectId: project.id,
              jwt,
              author: currentUsername,
              roleLevel: currentRoleLevel,
              context: {
                fileId: agentScopeFile?.id ?? undefined,
                cellId: agentScopeFile?.id === activeFileId ? focusedCellId ?? undefined : undefined,
              },
              fileName: agentScopeFile?.name,
              currentCell: null,
              rules,
              resolveCell: resolveCellById,
              onApplied: handleAgentApplied,
            }}
            onClose={() => navigate(`/project/${projectId}`)}
            onJumpToCell={(fileId, cellId) =>
              navigate(`/project/${projectId}/file/${fileId}?cellId=${encodeURIComponent(cellId)}`)
            }
          />
        ) : cellAreaState.kind === "ready" ? (
          // FRO-309: relative wrapper so the search-expanded overlay can cover the editor
          <div className="relative flex h-full w-full flex-col">
            {/* FRO-309: Expanded search results overlay */}
            {searchExpandedQuery !== null && (
              <div className="absolute inset-0 z-20 bg-background">
                <SearchResultsView
                  query={searchExpandedQuery}
                  results={searchResults}
                  onJumpToResult={(result) => {
                    setSearchExpandedQuery(null)
                    void handleSearchSelect(result, searchExpandedQuery)
                  }}
                  onClose={() => setSearchExpandedQuery(null)}
                />
              </div>
            )}
            <div className="min-h-0 flex-1">
              {lens === "audio" && activeFile && fileOrderedBy(activeFile) === "time" ? (
                <TimelineEditor
                  cells={legacyCells}
                  coreMediaUrl={activeFile.coreMediaUrl ?? null}
                  editable={!isReadOnly}
                  fileId={activeFile.id}
                  onRetime={handleRetime}
                  onCommitTarget={handleTimelineCommitTarget}
                  onLinkVideo={handleLinkVideo}
                />
              ) : (
              <EditorActionsProvider value={editorActionsValue}>
              {/* Dense grid: one tooltip-bearing control per cell across
                  hundreds of cells — opt into the delegated tooltip layer here
                  (see TooltipDelegationBoundary) instead of mounting a Base UI
                  tooltip per control. */}
              <TooltipDelegationBoundary>
              <EditorTable
            ref={editorRef} project={editorProject ?? project} cellStore={cellStore}
            showFootnotesInline={footnoteViewMode === "inline"}
            footnotePanelActive={footnoteViewMode !== "off"}
            footnoteViewMode={footnoteViewMode}
            onVisibleFootnotesChange={footnoteViewMode === "tray" ? handleVisibleFootnotesChange : undefined}
            username={currentUsername}
            activeLane={activeLane}
            lanes={availableLanes}
            archivedLanes={project?.archivedLanes}
            onLaneChange={setActiveLane}
            defaultLaneLabel={activeTargetLanguage || "Target"}
            // AQU-583: the TARGET tag is the discoverable entry point to change
            // the target language — deep-link to settings filtered to the
            // Project Info + Languages sections (both carry the "target language"
            // keyword), where the field is edited (server enforces the role floor).
            onEditTargetLanguage={() =>
              navigate(`/project/${projectId}/settings?q=${encodeURIComponent("target language")}`)
            }
            isCompletionConfigured={isConfigured} isCompletionAvailable={isCompletionAvailable} completing={completing}
            examples={examples} errors={errors} previews={previews}
            onCompleteSingle={handleCompleteSingle} onCompleteBatch={completeBatch}
            healthMap={effectiveHealthMap} infractions={infractions} rules={rules}
            isBacktranslationConfigured={isBacktranslationConfigured}
            onBacktranslate={runBacktranslation}
            onSaveBacktranslation={saveBacktranslation}
            backtranslating={backtranslating}
            backtranslationErrors={backtranslationErrors}
            backtranslationByCellId={backtranslationCache}
            cellOpenCommentCount={liveCellOpenCommentCount}
            getTokenForFile={getTokenForFile}
            getAlignmentModel={getAlignmentModel}
            getStatisticalBt={getStatisticalBt}
            onAlignmentSeedChange={handleAlignmentSeedChange}
            activeCueIndex={activeCueIndex >= 0 ? activeCueIndex : undefined}
            onSeekToCue={isSubtitleFile ? handleCueSeek : undefined}
            lineNumbersEnabled={fileMeta.lineNumbersEnabled}
            cellLabelsEnabled={cellLabelsEnabled}
            sourceDirectionMode={fileMeta.sourceDirectionMode}
            targetDirectionMode={fileMeta.targetDirectionMode}
            sourceTextDirection={fileMeta.sourceTextDirection}
            targetTextDirection={fileMeta.targetTextDirection}
            isAnonymous={!frontierSession}
            onJumpToCell={jumpToCellId}
            audioLens={audioLens}
            orderedBy={activeFile ? fileOrderedBy(activeFile) : undefined}
            onOpenAudioSetup={openAudioSetup}
            onAssignVoice={handleAssignVoice}
            onProjectChanged={refresh}
            onAddConceptFromSelection={handleAddConceptFromSelection}
            onAskAiFromSelection={handleAskAiFromSelection}
            onAttachMediaFile={handleAttachMediaFile}
            onAttachMediaUrl={handleAttachMediaUrl}
            onCellCommitted={handleCellCommitted}
            getPendingTargetEventId={getPendingTargetEventId}
            onOptimisticEdit={applyOptimisticTargetEditWithCapture}
            cellLockHolders={cellLockHolders}
            presenceStore={presenceStore}
            cellsWithRemoteChange={cellsWithRemoteChange}
            onClaimCell={handleClaimCell}
            onReleaseCell={handleReleaseCell}
            onTargetPresenceSelection={handleTargetPresenceSelection}
            onAckRemoteChange={handleAckRemoteChange}
            checkLockHolder={checkLockHolder}
            staleCellIds={staleCellIds}
            upstreamStaleCellIds={upstreamStaleCellIds}
            assignmentsByCellId={assignmentsByCellId}
            onVisibleRefChange={setTrackedCellRef}
          />
              </TooltipDelegationBoundary>
              </EditorActionsProvider>
              )}
            </div>
            {footnoteViewMode === "tray" && (
              <FootnotesTray
                entries={visibleFootnotes}
                editable={!isReadOnly}
                onSave={handleTrayFootnoteSave}
                onDelete={handleTrayFootnoteDelete}
                onClose={() => setFootnoteViewMode("off")}
              />
            )}
          </div>
        ) : (
          <CellAreaPlaceholder
            state={cellAreaState}
            fileName={activeFile?.name}
            hasFiles={projectFiles.length > 0}
            filesLoaded={status === "ready"}
            onImportClick={openImportFlow}
          />
        )}
        aside={
          <>
            {/* Parallel Bibles (helloao): edge tab → slide-out panel showing the
                scroll-tracked verse in other bible versions. Scripture files only. */}
            {centerSurface === "editor" && activeFile && fileTypeHasSections(activeFile.type) && (
              <ParallelBiblesSidebar
                key={activeFile.id}
                trackedRef={trackedCellRef}
                open={parallelBiblesOpen}
                onToggle={() => {
                  const next = !parallelBiblesOpen
                  setParallelBiblesOpen(next)
                  if (projectId) writeParallelBiblesOpen(projectId, next)
                }}
              />
            )}
            {/* FRO-179: Translation Notes sidebar — shown when a TN file exists
                and a translation cell with a matching canonicalRef is focused. */}
            <TranslationNotesSidebar
              projectId={projectId!}
              canonicalRef={focusedCellCanonicalRef}
              getToken={getTokenForFile}
              visible={tnSidebarVisible}
              onToggle={() => {
                const next = !tnSidebarVisible
                setTnSidebarVisible(next)
                if (projectId) writeTnSidebarVisible(projectId, next)
              }}
            />
            {checkOpen && (
              <CheckFindingsDrawer
                result={checkResult}
                running={checkRunning}
                cells={legacyCells}
                onClose={() => setCheckOpen(false)}
                onNavigateToCell={jumpToCellId}
                onOpenComments={(cellId) => {
                  // Reuse the existing comments drawer; one aside at a time.
                  setCheckOpen(false)
                  setCommentsCellId(cellId)
                }}
              />
            )}
            {drawerRuleId && (
              <RuleDrawer
                rule={drawerRule}
                infractions={drawerInfractions}
                cells={legacyCells}
                onClose={() => setDrawerRuleId(null)}
                onNavigateToCell={() => {}}
                project={project}
                username={currentUsername}
                refresh={refresh}
                cellsByFile={drawerCellsByFile}
              />
            )}
            {commentsCell && (
              <CommentsDrawer
                project={project} cell={commentsCell}
                liveComments={allProjectComments.filter(
                  (c) => c.cellId === commentsCell.id && c.deletedAt === null
                )}
                onClose={() => setCommentsCellId(null)}
                onNewThread={(text) => addThread(commentsCell.id, text)}
                onReply={(threadId, text) => addMessage(commentsCell.id, threadId, text)}
                onResolve={(threadId, msg) => resolveThread(commentsCell.id, threadId, msg)}
                onReopen={(threadId) => reopenThread(commentsCell.id, threadId)}
              />
            )}
            {historyCell && (
              <HistoryDrawer
                cell={historyCell}
                onClose={() => setHistoryCellId(null)}
                projectId={project?.id ?? null}
                fileId={activeFileId}
                getTokenForFile={getTokenForFile}
                isSynced={!!project?.syncRole}
                onPromote={handlePromoteToCurrentCell}
              />
            )}
          </>
        }
        statusBar={
          <>
            {lens === "audio" && project && centerSurface !== "agent" && (
              <VoicePlaybackBar
                cells={legacyCells}
                projectId={project.id}
                session={frontierSession ?? null}
                settings={tts.settings}
                onActiveCell={jumpToCellId}
              />
            )}
            <WorkspaceStatusBar
              left={
                <div className="flex min-w-0 items-center gap-1.5">
                  <PeerPresence peers={presencePeers} onJumpToPeer={handleJumpToPresencePeer} />
                  <SyncStatusIndicator status={fileSyncStatus} />
                  <OutboxSyncIndicator
                    pendingCount={Math.max(0, outboxPending - outboxFailed)}
                    failureStreak={outboxFailures}
                    failedCount={outboxFailed}
                    records={outboxRecords}
                    onRetryNow={outboxFlushNow}
                  />
                </div>
              }
            />
            {/* File translation stats belong to the editor; the workbench has
                its own working-set summary. Sync/outbox status above stays —
                agent Apply flushes through the same outbox. */}
            {centerSurface !== "agent" && (
              <StatusBar
                cells={cellSummaries}
                projectHealth={projectHealth}
                healthMap={healthMap}
                staleSourceCount={staleCellIds.size}
                onJumpToCell={jumpToCellId}
              />
            )}
          </>
        }
      />
      {project && (
        <SetupChecklistDrawer
          open={checklistOpen}
          onOpenChange={handleChecklistOpenChange}
          project={project}
          roleLevel={serverRoleLevel}
          state={checklistState}
          onProjectUpdated={handleProjectUpdated}
          onSharesChanged={refreshChecklistShares}
          onDismiss={() => {
            void dismissChecklist()
            setChecklistOpen(false)
          }}
          onOpenImport={() => setImportOpen(true)}
        />
      )}
      {project && (
        <AiSetupDialog
          open={aiSetupOpen}
          onOpenChange={setAiSetupOpen}
          project={project}
          onUpdated={handleProjectUpdated}
        />
      )}
      {/* FRO-192: Assign work modal */}
      {project && canAssignWork && (
        <AssignModal
          open={assignModalOpen}
          onOpenChange={setAssignModalOpen}
          projectId={project.id}
          activeFileId={activeFileId}
          projectFiles={projectFiles}
          targetLanes={project.targetLanes}
          defaultLane={activeLane}
          members={projectMembers}
          roleLevel={currentRoleLevel}
          allowSelfAssignment={allowSelfAssignment}
          callerUserId={currentUserId}
          selectedCellIds={getSelectedIds()}
          jwt={jwt ?? ""}
          author={currentUsername}
          onAssigned={() => setAssignmentsRefreshKey((k) => k + 1)}
        />
      )}
      {project && (
        <AudioRecordingModal
          open={recordingCellId !== null}
          project={project}
          cells={legacyCells}
          activeCellId={recordingCellId}
          username={currentUsername}
          onActiveCellChange={(cellId) => {
            setRecordingCellId(cellId)
            // Scroll the underlying editor to the new cell so the row is visible
            // when the modal closes.
            const idx = cellStore.findIndexByCellId(cellId)
            if (idx >= 0) editorRef.current?.scrollToCellIndex(idx)
          }}
          onClose={() => setRecordingCellId(null)}
        />
      )}
      {/* Manual boundary editor for a "Voice together" combined clip. */}
      {combinedEditor && activeFileId && project && (
        <CombinedBoundaryEditor
          project={audioProject ?? project}
          fileId={activeFileId}
          audioId={combinedEditor.audioId}
          url={combinedEditor.url}
          voiceId={combinedEditor.voiceId}
          referenceAudioId={combinedEditor.referenceAudioId}
          cells={combinedEditor.cells}
          session={frontierSession}
          username={currentUsername}
          onClose={() => setCombinedEditor(null)}
          onSaved={() => { setCombinedEditor(null); revalidateCells() }}
        />
      )}
      <Suspense fallback={null}>
        {/* FRO-287 glue: existingFiles activates the re-import collision guard. */}
        <ImportDialog open={importOpen} onOpenChange={setImportOpen}
          projectId={project.id}
          username={currentUsername}
          getToken={getTokenForFile}
          sourceLanguage={project.sourceLanguage} targetLanguage={project.targetLanguage}
          onImported={handleImported}
          sourceCells={importSourceCells}
          ttsSettings={tts.settings}
          onCastUpdated={(patch) => tts.saveTts(patch)}
          existingFiles={project.files}
          projectFiles={labelPickerFiles}
          activeFileId={activeFileId}
          onLabelsImported={(r) => {
            setTransientNotice(
              r.applied === 0
                ? {
                    message: `No labels applied — the CSV doesn't match ${r.fileName}. Re-download the template and try again.`,
                    severity: "warning",
                  }
                : r.unmatched > 0
                  ? {
                      message: `Applied ${r.applied} of ${r.applied + r.unmatched} labels to ${r.fileName}.`,
                      severity: "warning",
                    }
                  : {
                      message: `Applied ${r.applied} label${r.applied !== 1 ? "s" : ""} to ${r.fileName}.`,
                      severity: "success",
                    },
            )
          }}
          patchDcsCursor={async (cursor) => {
            // Pin the project to the imported Door43 release (spec §8). Server
            // floor is MAINTAINER(600); a below-floor caller gets a blocked
            // outcome (import still succeeded, only the pin is skipped).
            const outcome = await patchSettings({ dcsUpstream: cursor })
            return outcome.kind === "ok"
          }} />
      </Suspense>
      {activeFileId && (
        <Suspense fallback={null}>
          <FileTargetImportDialog
            open={fileImportOpen}
            onOpenChange={setFileImportOpen}
            projectId={project.id}
            username={currentUsername}
            fileName={activeFile?.name ?? "this file"}
            cells={fileTargetCells}
            getToken={getTokenForFile}
            applyOptimisticTargetEdits={applyOptimisticTargetEdits}
            onImported={() => { /* reconciliation handled by drain-complete effect (next task) */ }}
          />
        </Suspense>
      )}
      {/* Shared transient result notice (direction-role fallback, label import results, …).
          Severity tints match the workspace banner idiom (unintrusive 50-tint bg + 200 border).
          Success auto-dismisses; other severities carry an explicit close button. */}
      {transientNotice && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-4 right-4 z-60 flex max-w-sm items-start gap-2 rounded border px-3 py-2 text-sm shadow-md ${
            {
              error: "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
              warning: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
              success: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
              info: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200",
            }[transientNotice.severity]
          }`}
        >
          <span className="min-w-0">{transientNotice.message}</span>
          {transientNotice.severity !== "success" && (
            <button
              type="button"
              aria-label="Dismiss notice"
              onClick={() => setTransientNotice(null)}
              className="-mr-1 mt-0.5 shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      <Suspense fallback={null}>
        <ExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          canExport={canExportByOrgPolicy}
          cells={legacyCells}
          projectId={project.id}
          projectName={project.name ?? project.id}
          activeFileId={activeFileId ?? null}
          activeFileName={activeFile?.name ?? null}
          activeFileType={activeFile?.type ?? null}
          projectFiles={project.files.map((f) => ({ id: f.id, name: f.name, type: f.type }))}
          sourceLanguage={project.sourceLanguage}
          targetLanguage={project.targetLanguage}
          ttsSettings={tts.settings}
          getToken={getTokenForFile}
        />
      </Suspense>
      <ParallelPassagesPanel
        open={parallelOpen}
        onOpenChange={setParallelOpen}
        mode={parallelMode}
        onModeChange={setParallelMode}
        scope={parallelScope}
        onScopeChange={setParallelScope}
        activeFileId={activeFileId}
        activeFileName={activeFileId ? project.files.find((f) => f.id === activeFileId)?.name ?? null : null}
        activeDoc={doc}
        loading={searchLoading}
        ready={searchReady}
        results={searchResults}
        onReady={buildIndex}
        onSearch={runSearch}
        onSearchPassages={runSearchPassages}
        onClearResults={clearSearchResults}
        onSelect={handleSearchSelect}
        username={currentUsername}
        isReadOnly={isReadOnly}
        onAfterReplace={rebuildSearchIndex}
        onReplaceAll={handleReplaceAll}
      />
      <SharePanel
        open={shareOpen} onOpenChange={setShareOpen}
        projectId={projectId!}
        onSharesChanged={refreshChecklistShares}
      />
      <VideoAttachmentDialog
        open={videoDialogOpen} onOpenChange={setVideoDialogOpen}
        current={videoAttachment} onSave={saveVideo}
      />
      {/* FRO-272: soft-delete confirmation — file moves to "Recently deleted" (30-day retention). */}
      <ConfirmActionDialog
        open={pendingDeleteId !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteId(null) }}
        title="Move file to Recently deleted"
        description={(() => {
          const f = pendingDeleteId ? project.files.find((x) => x.id === pendingDeleteId) : null
          return f ? `Move "${f.name}" to Recently deleted? Cells and audio are kept for 30 days. You can restore the file or permanently delete it from "Recently deleted" in the sidebar's More menu.` : ""
        })()}
        confirmLabel="Move to Recently deleted"
        variant="destructive"
        onConfirm={() => { if (pendingDeleteId) { void handleDeleteFile(pendingDeleteId) } setPendingDeleteId(null) }}
      />
      {/* FRO-272: "Recently deleted" trash list — opened from the sidebar's
          More menu (project_lead+); was an inline expander in the files panel. */}
      <Dialog open={trashOpen} onOpenChange={setTrashOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Recently deleted</DialogTitle></DialogHeader>
          <div className="space-y-0.5">
            {deletedFiles.length === 0 && (
              <p className="px-1 py-1 text-sm text-muted-foreground">No recently deleted files.</p>
            )}
            {deletedFiles.map((f) => (
              <div key={f.fileId} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
                <span className="flex-1 truncate text-muted-foreground">{f.name}</span>
                <AppTooltip content="Cells and audio come back intact">
                  <button
                    type="button"
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs hover:bg-muted"
                    onClick={() => void handleRestoreFile(f.fileId)}
                  >
                    Restore
                  </button>
                </AppTooltip>
                <AppTooltip content="Permanently wipes R2 media" className="max-w-xs">
                  <button
                    type="button"
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs text-destructive hover:bg-destructive/10"
                    onClick={() => void handlePurgeFile(f.fileId)}
                  >
                    Delete forever
                  </button>
                </AppTooltip>
              </div>
            ))}
            <p className="px-1 pt-2 text-xs leading-snug text-muted-foreground">
              Files are kept for 30 days. "Delete forever" permanently wipes media.
            </p>
          </div>
        </DialogContent>
      </Dialog>
      {moveTargetId !== null && (
        <MoveToCorpusDialog
          // Remount per-open so internal state resets cleanly without an effect.
          key={moveTargetId}
          initialValue={moveCorpus}
          existingMarkers={existingCorpusMarkers}
          onClose={() => setMoveTargetId(null)}
          onSave={async (next) => {
            if (!project) return
            await patchProject(project.id, (p) => moveFileToCorpus(p, moveTargetId, next))
            refresh()
            setMoveTargetId(null)
          }}
        />
      )}
      {undo && (
        <div className="fixed bottom-4 right-4 z-60 flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-sm">
          <span>Applied renames.</span>
          <Button size="sm" variant="outline" onClick={() => {
            if (!project || !undo) return
            const reverted = buildUndo(project, undo.chosen)
            setClientProject(reverted)
            void updateProject(reverted)
            const nameChanges = undo.chosen.filter((s) => s.currentName !== s.suggestedName)
            if (nameChanges.length > 0) {
              void Promise.all(
                nameChanges.map((s) =>
                  emitFileRename({
                    projectId: project.id,
                    fileId: s.fileId,
                    name: s.currentName,
                    author: currentUsername,
                  }),
                ),
              ).then(() => refresh())
            }
            setOptimisticRenames((current) => {
              const next = new Map(current)
              for (const s of undo.chosen) next.delete(s.fileId)
              return next
            })
            setUndo(null)
          }}>Undo</Button>
        </div>
      )}
    </EditorScrollProvider>
  )
}

// Pick from existing corpus markers via a native <select>, with an inline
// "Other…" option to create a brand-new marker. Replaces the prior free-text
// input that hid the existing options behind the dialog's backdrop blur (#39).
// Caller wraps with `key` so internal state resets on each open.
function MoveToCorpusDialog({
  initialValue, existingMarkers, onClose, onSave,
}: {
  initialValue: string
  existingMarkers: ReadonlyArray<string>
  onClose: () => void
  onSave: (value: string) => void | Promise<void>
}) {
  const NEW = "__new__"
  const trimmed = initialValue.trim()
  const initIsNew = trimmed.length > 0 && !existingMarkers.includes(trimmed)
  const [selection, setSelection] = useState(initIsNew ? NEW : trimmed)
  const [customValue, setCustomValue] = useState(initIsNew ? trimmed : "")
  const isNew = selection === NEW
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Move to corpus</DialogTitle></DialogHeader>
        <select
          value={selection}
          onChange={(e) => setSelection(e.target.value)}
            className="bg-muted w-full rounded px-2 py-1.5 text-sm"
        >
          <option value="">Ungrouped</option>
          {existingMarkers.map((m) => <option key={m} value={m}>{m}</option>)}
          <option value={NEW}>Other…</option>
        </select>
        {isNew && (
          <input
            autoFocus
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            placeholder="New corpus name"
              className="bg-muted mt-2 w-full rounded px-2 py-1 text-sm"
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={isNew && !customValue.trim()}
            onClick={() => { void onSave(isNew ? customValue : selection) }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── ScrollToGroupHandler ───────────────────────────────────────────────────
// Must render inside <EditorScrollProvider> so useEditorScroll() has context.
// Watches pendingGroup and scrolls the first matching cell into view via the
// forwarded editorRef.

interface ScrollToGroupHandlerProps {
  cellStore: CellStore
  storeVersion: number
  editorRef: React.RefObject<EditorTableHandle | null>
}

function ScrollToGroupHandler({ cellStore, storeVersion, editorRef }: ScrollToGroupHandlerProps) {
  const editorScroll = useEditorScroll()

  useEffect(() => {
    void storeVersion
    const pending = editorScroll.pending
    if (!pending) return
    const { group: groupId, section: sectionLabel, fileId: targetFileId } = pending

    // FRO-250/254: only consume() when the active store belongs to the requested
    // file. During a file-switch the pending request may already carry the NEW
    // file's id while the store is still clearing/loading; consuming early would
    // jump nowhere and burn the request.
    const currentFileId = cellStore.getFileId()
    if (targetFileId !== null && currentFileId !== targetFileId) {
      // Leave the request pending until the store has been replaced.
      return
    }

    editorScroll.consume()
    if (!groupId && !sectionLabel) return

    let idx = -1
    if (sectionLabel) {
      idx = cellStore.findIndexBySection(sectionLabel)
    } else if (groupId) {
      idx = cellStore.getAllSummaries().findIndex((cell) => (cell.group ?? "Ungrouped") === groupId)
    }

    if (idx >= 0) {
      // Defer a tick so the virtualized list has the latest cell list after any
      // file-switch that preceded this request.
      setTimeout(() => {
        editorRef.current?.scrollToCellIndex(idx)
      }, 0)
    }
  }, [cellStore, editorScroll, editorRef, storeVersion])

  return null
}

interface TrashedProjectScreenProps {
  project: ProjectRecord
  onClose: () => void
  onRestore: () => void | Promise<void>
}

function TrashedProjectScreen({ project, onClose, onRestore }: TrashedProjectScreenProps) {
  const { session } = useFrontierSession()
  const canRestore =
    (project.syncRole?.level ?? 0) >= 700 ||
    (!project.origin && !project.syncRole) ||
    session == null

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="bg-card max-w-md rounded-2xl p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Trash2 className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="mb-2 text-lg font-semibold">This project is in Trash</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          "{project.name}" was moved to Trash
          {project.deletedBy ? ` by ${project.deletedBy}` : ""}.
          Restore it to continue editing.
        </p>
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" onClick={onClose}>
            Back to Dashboard
          </Button>
          {canRestore && (
            <Button onClick={() => onRestore()}>
              <Undo2 className="mr-1 h-4 w-4" />
              Restore
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
