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
import { useCells } from "@/hooks/useCells"
import { useStaleSourceCells } from "@/hooks/useStaleSourceCells"
import { useSearchIndex } from "@/hooks/useSearchIndex"
import { useCompletion } from "@/hooks/useCompletion"
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
import { MAX_BATCH_COMPLETIONS } from "@/lib/workspace-actions/registry"
import type { FileReference } from "@/lib/parsers/types"
import { fileOrderedBy, fileTypeHasSections } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { useWorkspaceSearch } from "@/hooks/useWorkspaceSearch"
import { ParallelPassagesPanel, type ParallelPanelMode, type ParallelPanelScope, type ReplaceAllPayload } from "./ParallelPassagesPanel"
import type { EditorTableHandle } from "./EditorTable"
import type { WorkspaceSearchResult } from "@/hooks/useWorkspaceSearch"
import { StatusBar } from "./StatusBar"
import { SyncStatusIndicator } from "./SyncStatusIndicator"
import { OutboxSyncIndicator } from "./OutboxSyncIndicator"
import { EditorTable, type AudioLensContext } from "./EditorTable"
import { FootnotesTray } from "./footnotes/FootnoteInline"
import { AudioRecordingModal } from "./AudioRecorder/AudioRecordingModal"
import { VoiceSidebar } from "./voice/VoiceSidebar"
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
import {
  setCqrsOutboxBridge,
  buildFileScopedTokenFetcher,
  buildProjectAwareMinter,
} from "@/lib/sync/cqrs-bridge"
import { emitTargetCellCommit, emitCellBacktranslationSet, emitFileRename, emitFileDelete, emitFileRestore, emitCellValidate } from "@/lib/sync/events-emit"
import { applyPresenceFrame, applyLockClaimed, applyLockReleased } from "@/lib/sync/cell-lock-state"
import { canPerform } from "@/lib/sync/role-policy"
import { useFocusLock } from "@/hooks/useFocusLock"
import type { WsReconciler } from "@/lib/sync/ws-reconciler"
import { flushOutboxBatch } from "@/lib/sync/outbox-flush"
import { runDiarization, type DiarizationPhase } from "@/lib/diarization/run-diarization"
import { attachMediaFileToTimeline, attachMediaUrlToTimeline } from "@/lib/timeline/attach-media"
import { useCellsAuditStatsWithOverlay } from "@/hooks/useCellsAuditStatsWithOverlay"
import { useComments } from "@/hooks/useComments"
import { Film, Scale, MessagesSquare, Share2, Settings as SettingsIcon, Lock, ClipboardList, Trash2, Undo2, Sparkles, Mic2, BookMarked, BookOpen, Users, UserCheck, Eye, ArrowRight, PanelLeftClose } from "lucide-react"
import { ChatPanel } from "./ChatPanel"
import { ChatDockPanel } from "./ChatDockPanel"
import { SearchDockPanel } from "./SearchDockPanel"
import { SearchResultsView } from "./search/SearchResultsView"
import { LeftDock, type DockTab } from "./LeftDock"
import { useChat } from "@/hooks/useChat"
import { TranslationNotesSidebar, readTnSidebarVisible, writeTnSidebarVisible } from "./TranslationNotesSidebar"
import { ParallelBiblesSidebar, readParallelBiblesOpen, writeParallelBiblesOpen } from "./ParallelBiblesSidebar"
import { InactiveProjectBanner } from "./InactiveProjectBanner"
import { OfflineBanner } from "./OfflineBanner"
import { useProjectLifecycle } from "@/hooks/useProjectLifecycle"
import { restoreProject } from "@/lib/store/project-index"
import { AppShell } from "./AppShell"
import { WorkspaceHeader } from "./WorkspaceHeader"
import { EditorModeToggle } from "./EditorModeToggle"
import { useEditorLensPreference } from "@/hooks/useEditorLensPreference"
import { SelectionBar } from "./SelectionBar"
import { WorkspaceStatusBar } from "./WorkspaceStatusBar"
import { PrimaryActionButton } from "./PrimaryActionButton"
import { AccountSwitcher } from "./AccountSwitcher"
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
import { detectSuggestions, type RenameSuggestion } from "@/lib/file-labeling/detect"
import { applySuggestions, buildUndo } from "@/lib/file-labeling/apply"
import { renameFile, moveFileToCorpus, renameCorpus, deleteFile } from "@/lib/store/file-operations"
import { deleteFileProjection } from "@/lib/sync/file-projection"
import { fetchDeletedFiles } from "@/lib/sync/cells-read"
import type { FileSummary } from "@/lib/sync/cells-read-types"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import type { ProjectRecord } from "@/lib/parsers/types"
import { readValidationCount } from "@/lib/progress/read-validation-count"
import { useSetupChecklist } from "@/hooks/useSetupChecklist"
import { SetupChecklistDrawer } from "./onboarding/SetupChecklistDrawer"
import { SystemPromptNudge } from "./onboarding/SystemPromptNudge"
import { CompletionBulkProgressBanner } from "./CompletionBulkProgressBanner"
import { AppTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useNextUnfinished } from "@/hooks/useNextUnfinished"
import { AiSetupDialog } from "./AiSetupDialog"
import {
  buildProjectSettingsHandoffUrl,
  workspaceReturnPath,
} from "@/lib/ad11/navigation"
import { generateBacktranslation } from "@/lib/completion/backtranslation-service"
import { addConcept } from "@/lib/terminology/store"
import type { Concept } from "@/lib/terminology/types"
import { buildGlosser, type BtSeed } from "@/lib/completion/bt-glosser"
import { buildAlignmentModel } from "@/lib/completion/interlinear"
import { buildStatisticalBt } from "@/lib/completion/bt-auto"
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
const TerminologyPageContent = lazy(() =>
  import("./TerminologyPage").then((mod) => ({ default: mod.TerminologyPage })),
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

export function ProjectWorkspace() {
  const { id: projectId, fileId: routeFileId } = useParams<{ id: string; fileId?: string }>()
  const navigate = useNavigate()
  const { activeOrg, activeOrgId, isAllOrgs } = useActiveOrg()
  const goToProjects = useCallback(() => {
    navigate({
      pathname: "/",
      search: isAllOrgs ? "?org=all" : activeOrgId != null ? `?org=${activeOrgId}` : "",
    })
  }, [activeOrgId, isAllOrgs, navigate])
  const { project: loadedProject, status, refresh, patchSettings } = useProject(projectId!)
  // Client-local overlays (corpusMarker, originalName, suggestionsDismissedAt)
  // live in IDB; merge them onto the server-fetched record on load and after
  // each local patch so rename suggestions don't loop on every open.
  const [clientProject, setClientProject] = useState<ProjectRecord | null>(null)

  useEffect(() => {
    if (!loadedProject) {
      setClientProject(null)
      return
    }
    let cancelled = false
    void getProject(loadedProject.id).then((local) => {
      if (cancelled) return
      setClientProject(mergeServerProjectWithLocalCache(loadedProject, local))
    })
    return () => { cancelled = true }
  }, [loadedProject])

  const hydratedProject = clientProject ?? loadedProject

  const [selectedFileId, setSelectedFileId] = useState<string | null>(routeFileId ?? null)
  const activeFileId = routeFileId ?? selectedFileId

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
  // FRO-249/FRO-255 fix (Fix 4): transient notice shown when the user explicitly
  // confirmed a direction but their role is below MAINTAINER (600) so the change
  // could not be saved project-wide. Auto-dismissed after 6 s.
  const [directionRoleNotice, setDirectionRoleNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!directionRoleNotice) return
    const t = setTimeout(() => setDirectionRoleNotice(null), 6000)
    return () => clearTimeout(t)
  }, [directionRoleNotice])
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

  const project = useMemo<ProjectRecord | null>(() => {
    if (!hydratedProject) return null
    if (projectFiles === hydratedProject.files) return hydratedProject
    return { ...hydratedProject, files: projectFiles }
  }, [hydratedProject, projectFiles])

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
      location.pathname.endsWith("/members")
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
  // File-scoped target import dialog ("Import translations into this file").
  const [fileImportOpen, setFileImportOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [drawerRuleId, setDrawerRuleId] = useState<string | null>(null)
  const [searchParams] = useSearchParams()

  // Center surface — derived from the URL path so deep-links work and the
  // shell (sidebar + top bar + bottom status bar) never unmounts.
  // FRO-194 added "rules"; FRO-254 adds "comments", "memory", "terminology";
  // FRO-180 adds "members".
  const centerSurface: "editor" | "rules" | "comments" | "memory" | "terminology" | "members" =
    location.pathname.endsWith("/rules") ? "rules" :
    location.pathname.endsWith("/comments") ? "comments" :
    location.pathname.endsWith("/memory") ? "memory" :
    location.pathname.endsWith("/terminology") ? "terminology" :
    location.pathname.endsWith("/members") ? "members" :
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
  const [parallelOpen, setParallelOpen] = useState(false)
  const [parallelMode, setParallelMode] = useState<ParallelPanelMode>("search")
  const [parallelScope, setParallelScope] = useState<ParallelPanelScope>("project")
  const [shareOpen, setShareOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  // FRO-308: left dock active tab (null = collapsed rail only)
  const [dockTab, setDockTab] = useState<DockTab | null>("files")
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
  // ISSUE-3 fix: /project/:id/voice deep-link activates audio lens on mount.
  useEffect(() => {
    if (location.pathname.endsWith("/voice")) setLens("audio")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])
  // A2: "Open audio setup" CTA from the cell error popover must navigate to a
  // page where the Gemini API key can be set. The old implementation called
  // setLens("audio") which is a no-op when already in audio mode. Navigate to
  // project settings instead so the key field is always reachable.
  const openAudioSetup = useCallback(() => {
    if (!projectId) return
    navigate(`/project/${projectId}/settings`)
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
  } = useCellsAuditStatsWithOverlay({
    enabled: auditStatsEnabled,
    fileId: activeFileId,
    getTokenForFile,
  })

  const validationCount = project ? readValidationCount(project) : 1
  // Phase 2a: useCells reads from D1 via the sync-worker's HTTP read route.
  // The Y.Doc is still wired for writes + the Tiptap editor; this just
  // changes the load path for the cells list. See useCells.ts for the full
  // story.
  const { cells, revalidate: revalidateCells, revalidateCell, applyOptimisticTargetEdit, isLoading: cellsLoading } = useCells({
    projectId: project?.id ?? null,
    fileId: activeFileId,
    username: currentUsername,
    requiredValidations: validationCount,
    auditStats: auditStatsByCellId,
    getToken: getTokenForFile,
    enabled: Boolean(project?.id && activeFileId && frontierSession?.jwt),
  })

  // ── Auto-BT on target commit ─────────────────────────────────────────────
  // Track the last cell that received an optimistic target edit so we can
  // recompute its statistical BT when `handleCellCommitted` fires (after the
  // outbox flush). EditorTable calls applyOptimisticTargetEdit immediately
  // before emitting the commit event, so this ref is always up-to-date by
  // the time onCellCommitted fires.
  const lastOptimisticEditRef = useRef<{ cellId: string; translatedText: string } | null>(null)

  // RACE-3/QW-2: per-cell pending event id for the AI completion commit path.
  // Mirrors the per-row pendingTargetEventIdRef in EditorRow. Keyed by cellId
  // so concurrent completions on different cells don't cross-contaminate.
  const pendingCompletionEventIdRef = useRef<Map<string, string>>(new Map())

  // Stable refs so that callbacks declared BEFORE glosser/persistBt (in React
  // hook order) can still call the latest version without stale-closure issues.
  // Updated unconditionally each render — refs never cause re-renders.
  const glosserRef = useRef<import("@/lib/completion/bt-glosser").Glosser | null>(null)
  const persistBtRef = useRef<((cell: CellData, btText: string, polished: boolean) => void) | null>(null)
  // cellsRef is already declared later in the file (line ~689) — we reuse it.
  const setBacktranslationCacheRef = useRef<React.Dispatch<React.SetStateAction<Map<string, string>>> | null>(null)

  // Wrap applyOptimisticTargetEdit to capture which cell was last edited.
  // We pass this wrapped version to EditorTable so we intercept without
  // touching EditorTable.tsx.
  const applyOptimisticTargetEditWithCapture = useCallback(
    (cellId: string, patch: { value: string; valueHtml?: string }) => {
      if (patch.value) {
        lastOptimisticEditRef.current = { cellId, translatedText: patch.value }
      }
      applyOptimisticTargetEdit(cellId, patch)
    },
    [applyOptimisticTargetEdit],
  )
  // Phase 5 / AD-9 — Phase 3a-final wiring. Fetch the set of cell ids
  // whose source has advanced since the translator's last commit, so the
  // editor table can decorate stale rows with the AlertTriangle badge.
  // One fetch per (projectId, fileId) — flattened to a boolean per row
  // inside EditorTable.
  const { staleCellIds } = useStaleSourceCells({
    projectId: project?.id ?? null,
    fileId: activeFileId,
    getToken: getTokenForFile,
    enabled: Boolean(project?.id && activeFileId && frontierSession?.jwt),
  })

  // Audio lens: TTS settings (engine, voice library, cast) hydrated from IDB
  // and overlaid onto the project so generation uses the real engine/key/cast.
  const tts = useProjectTts(
    project?.id ?? null,
    project?.ttsSettings,
    cells,
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
              const cell = enrichedCell ?? cells.find((c) => c.id === cellId)
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
      frontierSession, currentUsername, cells, refresh,
    ],
  )

  const { hasAny: hasUnfinished, findNext: findNextUnfinished } = useNextUnfinished(cells, validationCount)
  const handleJumpNextUnfinished = useCallback(() => {
    const currentIndex = editorRef.current?.getCurrentIndex?.() ?? 0
    const next = findNextUnfinished(currentIndex)
    if (next >= 0) editorRef.current?.scrollToCellIndex(next)
  }, [findNextUnfinished])
  const fileMeta = useFileMeta(activeFileId, project?.sourceLanguage, project?.targetLanguage)
  const [cellLabelsEnabled, setCellLabelsEnabled] = useCellLabelsPreference(projectId!)
  const [footnoteViewMode, setFootnoteViewMode] = useFootnotesPreference(projectId!)
  const [visibleFootnotes, setVisibleFootnotes] = useState<VisibleFootnoteEntry[]>([])
  const visibleFootnotesKeyRef = useRef("")
  // FRO-251: per-file, per-side font sizes — adjusted from the View settings
  // (eye) menu, rendered by EditorTable.
  const fontSizes = useFileFontSizes(activeFileId)

  const activeFile = activeFileId ? project?.files.find((f) => f.id === activeFileId) : null
  const isSubtitleFile = activeFile?.type === "vtt" || activeFile?.type === "srt"

  const handleVisibleFootnotesChange = useCallback((entries: VisibleFootnoteEntry[]) => {
    const key = entries
      .map((entry) => [
        entry.cellId,
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
    !!activeFile && fileOrderedBy(activeFile) === "time" && cells.some((c) => c.medium === "media")
  const handleDiarize = useCallback(async () => {
    if (!project?.id || !activeFileId) return
    setDiarizeError(null)
    try {
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
  }, [project?.id, activeFileId, currentUsername, cells, getTokenForFile, getTokenForProjectFile, tts.settings, tts.saveTts, revalidateCells])

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
    if (!isSubtitleFile || !videoSrc || cells.length === 0) return []
    return extractCuesFromCells(cells)
  }, [cells, isSubtitleFile, videoSrc])

  const videoStartOffset = videoAttachment.videoStartOffset ?? 0

  // Active cue is in cue-space (not raw video time). Adjust by offset.
  const cueTime = currentVideoTime - videoStartOffset
  const activeCueIndex = useMemo(() => {
    if (!isSubtitleFile) return -1
    for (let i = 0; i < cells.length; i++) {
      const range = parseTimestampRange(cells[i].context)
      if (!range) continue
      if (cueTime >= range.start && cueTime <= range.end) {
        return i
      }
    }
    return -1
  }, [cells, cueTime, isSubtitleFile])

  useEffect(() => {
    if (activeCueIndex < 0) return
    const timer = setTimeout(() => {
      editorRef.current?.scrollToCellIndex(activeCueIndex)
    }, 500)
    return () => clearTimeout(timer)
  }, [activeCueIndex])

  const handleCueSeek = useCallback((cellId: string) => {
    const cell = cells.find((c) => c.id === cellId)
    if (!cell) return
    const range = parseTimestampRange(cell.context)
    if (!range) return
    // Seek in raw video time = cue-space start + offset
    videoPlayerRef.current?.seekTo(range.start + videoStartOffset)
    videoPlayerRef.current?.play().catch(() => { /* autoplay blocked */ })
  }, [cells])

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

  // Captures the latest cells in a ref so post-navigation flash can read them
  // without racing React re-renders.
  const cellsRef = useRef(cells)
  useEffect(() => { cellsRef.current = cells }, [cells])

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
  } = useOrgSettings(
    activeOrg?.id,
    activeOrg?.role?.level,
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
  const commentsCell = commentsCellId ? cells.find((c) => c.id === commentsCellId) : null
  const historyCell = historyCellId ? cells.find((c) => c.id === historyCellId) : null

  // Build fileCells map for health computation
  // For now, only the active file's cells are loaded
  const fileCells = useMemo(() => {
    const map = new Map<string, CellData[]>()
    if (activeFileId && cells.length > 0) {
      map.set(activeFileId, cells)
    }
    return map
  }, [activeFileId, cells])

  const allProjectCells = useMemo(() => {
    const all: CellData[] = []
    for (const [, fc] of fileCells) all.push(...fc)
    return all
  }, [fileCells])

  // FRO-191 (orchestrator glue): existing-cell refs for the eBible "into target
  // column" import mode. CellData.group carries the canonical ref.
  const importSourceCells = useMemo(() => allProjectCells.map((c) => ({
    cellId: c.id,
    fileId: c.fileId,
    targetEventId: c.targetEventId,
    sourceEventId: c.sourceEventId,
    translated: c.translated ?? "",
    canonicalRef: c.group,
  })), [allProjectCells])

  // File-scoped target import: the open file's cells in display order, with
  // source text so the review screen can show alignment.
  const fileTargetCells = useMemo(() => cells.map((c) => ({
    cellId: c.id,
    fileId: c.fileId,
    targetEventId: c.targetEventId,
    sourceEventId: c.sourceEventId,
    translated: c.translated ?? "",
    canonicalRef: c.group,
    original: c.original,
  })), [cells])

  const { search, searchPassages } = useSearchIndex(project?.files || [], allProjectCells)

  // AD-13 branching-search adapters — single-cell completion's few-shot
  // retrieval (`branchingSearch`) and the batch completion's passage
  // retrieval (`branchingSearchPassages`). Replace the in-memory dual-
  // index calls with server fetches so the AI copilot uses the same
  // retrieval primitive every other AD-13 consumer will (AD-14 decay
  // endorsement included).
  //
  // Both fall back to the in-memory index if the server fetch fails for
  // any reason (offline, JWT issue, etc.) — losing retrieval makes the
  // copilot zero-shot, which is a worse generation but still better than
  // failing the whole completion.
  const branchingSearch = useCallback(
    async (
      query: string,
      limit?: number,
      excludeId?: string,
    ): Promise<ScoredPair[]> => {
      const pid = project?.id
      const fid = activeFileId
      if (!pid || !fid) return search(query, limit, excludeId)
      const jwt = await getTokenForFile(fid)
      if (!jwt) return search(query, limit, excludeId)
      try {
        const res = await fetchBranchingSearch({
          projectId: pid,
          query,
          jwt,
          topK: limit,
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
        console.warn("[ProjectWorkspace] branching-search fetch failed, falling back to local index:", err)
        return search(query, limit, excludeId)
      }
    },
    [project?.id, activeFileId, getTokenForFile, search],
  )

  const branchingSearchPassages = useCallback(
    async (
      query: string,
      hits?: number,
      radius?: number,
    ): Promise<PassageHit[]> => {
      const pid = project?.id
      const fid = activeFileId
      if (!pid || !fid) return Promise.resolve(searchPassages(query, hits, radius))
      const jwt = await getTokenForFile(fid)
      if (!jwt) return Promise.resolve(searchPassages(query, hits, radius))
      try {
        const res = await fetchBranchingSearchPassages({
          projectId: pid,
          query,
          jwt,
          topK: hits,
          radius,
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
        console.warn("[ProjectWorkspace] branching-search-passages fetch failed, falling back to local index:", err)
        return searchPassages(query, hits, radius)
      }
    },
    [project?.id, activeFileId, getTokenForFile, searchPassages],
  )

  const commitCompletedCell = useCallback(async (cell: CellData, text: string, author: string) => {
    if (!project?.id) return
    // Optimistic local patch BEFORE the outbox enqueue. Mirrors what
    // handleEditorCommit in EditorTable does for hand-typed edits, and
    // collapses the race window where `cells.translated` would otherwise
    // stay at the old value until `revalidateCells` fetched from the
    // server. Without this, TipTap's `initialPlain` is briefly stale and
    // any TipTap-side commit fired during that window (DOM reflow when
    // the loading overlay vanishes, a virtualizer remount, a focus
    // bounce) chains a *revert* event with the pre-gen text onto the
    // gen — producing the "two events at 5:08, second one identical to
    // 2:28" history pattern.
    applyOptimisticTargetEdit(cell.id, { value: text })
    // RACE-3/QW-2: use the pending event id for this cell (last AI-completion
    // commit we enqueued) as parentId, falling back to the projection value.
    // This prevents a second rapid completion commit from becoming a sibling
    // of the first (which the server dead-letters) when the read-back hasn't
    // landed yet.
    const parentId = pendingCompletionEventIdRef.current.get(cell.id) ?? cell.targetEventId ?? cell.sourceEventId ?? null
    const eventId = await emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      parentId,
      sourceEventId: cell.sourceEventId ?? null,
      value: text,
      author,
      // FRO-292: tag AI-generated commits so the server projection can
      // track ai_drafted on the cell row. A human edit (no aiSuggestion)
      // will clear it on the next commit.
      aiSuggestion: true,
    })
    pendingCompletionEventIdRef.current.set(cell.id, eventId)
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    revalidateAuditStats()
    // Targeted: we just changed exactly one cell. Pull only that row back
    // (its authoritative event_id becomes the next commit's parent) instead of
    // re-streaming all ~30k source cells. The optimistic shadow keeps the value
    // visible until this confirms; the WS event.applied also pokes the same
    // cell (coalesced).
    revalidateCell(cell.id)

    // ── Auto statistical BT after AI completion commit (FRO-203) ───────────
    // Runs synchronously — no network, no extra loading state. LLM polish
    // remains opt-in via runBacktranslation (the Generate button path).
    // Uses stable refs so this callback doesn't need glosser/persistBt in
    // its dep array (they are declared later in hook order).
    if (text.trim() && glosserRef.current && persistBtRef.current && setBacktranslationCacheRef.current) {
      const btText = buildStatisticalBt(glosserRef.current, text)
      if (btText) {
        setBacktranslationCacheRef.current((prev) => new Map(prev).set(cell.id, btText))
        persistBtRef.current(cell, btText, false)
      }
    }
  }, [project?.id, applyOptimisticTargetEdit, getTokenForProjectFile, refreshOutboxPending, revalidateAuditStats, revalidateCell])

  /**
   * AD-2 sibling promotion: emit a new target-cell commit whose parentId is
   * the current chain head (historyCell.targetEventId). This makes the
   * promoted text the new current value while the prior head becomes a stale
   * sibling — exactly the first-child-of-parent win rule applied in reverse.
   */
  const handlePromoteToCurrentCell = useCallback(async (entry: import("@/lib/parsers/types").CellHistoryEntry) => {
    if (!project?.id || !historyCellId) return
    const cell = cells.find((c) => c.id === historyCellId)
    if (!cell) return
    applyOptimisticTargetEdit(cell.id, { value: entry.value })
    await emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      // parentId must be the current chain head so AD-2 makes this the winner.
      parentId: cell.targetEventId ?? cell.sourceEventId ?? null,
      sourceEventId: cell.sourceEventId ?? null,
      value: entry.value,
      author: currentUsername,
    })
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    revalidateAuditStats()
    // Single-cell promotion — targeted refetch (see commitCompletedCell).
    revalidateCell(cell.id)
  }, [project?.id, historyCellId, cells, applyOptimisticTargetEdit, getTokenForProjectFile, currentUsername, refreshOutboxPending, revalidateAuditStats, revalidateCell])

  const { completeSingle, completeBatch, isConfigured, isAvailable: isCompletionAvailable, completing, examples, errors, previews } = useCompletion(
    project?.completionSettings, project?.sourceLanguage || "", project?.targetLanguage || "", branchingSearch, branchingSearchPassages, frontierSession, commitCompletedCell, rules, allProjectCells
  )

  // FRO-175: workspace AI chat panel
  const chat = useChat({
    settings: project?.completionSettings,
    session: frontierSession,
    sourceLanguage: project?.sourceLanguage || "",
    targetLanguage: project?.targetLanguage || "",
    currentFileName: activeFile?.name,
    projectId: project?.id,
  })

  // Translation agent (chat dock Agent mode): live cell lookup for proposal
  // lint + chain heads, and the post-apply flush/revalidate sequence — the
  // same steps commitCompletedCell runs after its own enqueue.
  const resolveCellById = useCallback(
    (cellId: string) => cellsRef.current.find((c) => c.id === cellId),
    [],
  )
  const handleAgentApplied = useCallback(
    async (_eventIds: string[], cellIds: string[]) => {
      await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
      await refreshOutboxPending()
      revalidateAuditStats()
      for (const cellId of cellIds) revalidateCell(cellId)
    },
    [getTokenForProjectFile, refreshOutboxPending, revalidateAuditStats, revalidateCell],
  )

  // ── Back-translation: statistical primary path + optional LLM polish ────────
  //
  // Generation strategy (per spec):
  //  1. Statistical Markov glosser over all translated (source↔target) pairs.
  //     Runs synchronously — no network, always succeeds.
  //  2. Optional LLM polish step when `polished: true` — calls generateBacktranslation.
  //
  // Persistence:
  //  - On generate: emit `cell.backtranslation.set` via outbox (non-chain-mutating).
  //  - Local in-memory cache (`backtranslationCache`) so UI is instant.
  //  - localStorage fallback so results survive page reload before server round-trip.
  //
  const [backtranslationCache, setBacktranslationCache] = useState<Map<string, string>>(new Map())
  const [backtranslatingState, setBacktranslatingState] = useState<Set<string>>(new Set())
  const [backtranslationErrorsState, setBacktranslationErrorsState] = useState<Map<string, string>>(new Map())

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

  const isBacktranslationConfigured = Boolean(project?.completionSettings && isConfigured)

  // Build the glosser from ALL translated pairs in the project. Memoized on
  // allProjectCells so it only rebuilds when the corpus changes.
  const glosser = useMemo(() => {
    const pairs = allProjectCells
      .filter((c) => c.original?.trim() && c.translated?.trim())
      .map((c) => ({ source: c.original!, target: c.translated }))
    // High-weight seeds from previous user-corrected BTs stored in the cache.
    // Corrected BTs (saved via onSaveBacktranslation) are re-fed as seeds so
    // future glosses reflect the reviewer's intent.
    const seeds: BtSeed[] = []
    for (const [cellId, btText] of backtranslationCache) {
      const cell = allProjectCells.find((c) => c.id === cellId)
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
    return buildGlosser(pairs, seeds)
  }, [allProjectCells, backtranslationCache, project?.terminology])

  // Build the interlinear alignment model from the same corpus, seeded with the
  // user's confirmed/invalidated alignments (FRO-207). Memoized on the corpus +
  // persisted alignmentSeeds so it only rebuilds when either changes.
  const alignmentModel = useMemo(() => {
    const pairs = allProjectCells
      .filter((c) => c.original?.trim() && c.translated?.trim())
      .map((c) => ({ source: c.original!, target: c.translated }))
    return buildAlignmentModel(pairs, project?.alignmentSeeds ?? [])
  }, [allProjectCells, project?.alignmentSeeds])

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
    // 1. In-memory cache
    setBacktranslationCache((prev) => new Map(prev).set(cell.id, btText))

    // 2. localStorage fallback (survives reload before server round-trip)
    try {
      const lsKey = `bt:${project?.id ?? ""}:${cell.id}`
      localStorage.setItem(lsKey, JSON.stringify({
        btText,
        polished,
        targetEventId: cell.targetEventId ?? "",
        savedAt: Date.now(),
      }))
    } catch { /* ignore quota/private-browsing errors */ }

    // 3. Outbox event
    if (!project?.id || !cell.fileId || !cell.targetEventId) {
      console.warn("[bt-persist] missing project/file/targetEventId — skipping outbox emit")
      return
    }
    void emitCellBacktranslationSet({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      btText,
      targetEventId: cell.targetEventId,
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

  // ── Keep stable refs in sync every render (FRO-203) ────────────────────
  // These allow commitCompletedCell / handleCellCommitted (declared earlier or
  // later in hook order) to always call the latest glosser + persistBt without
  // circular dependency issues in useCallback deps arrays.
  glosserRef.current = glosser
  persistBtRef.current = persistBt
  // cellsRef.current is kept in sync by the useEffect at ~line 690 — no update needed here.
  setBacktranslationCacheRef.current = setBacktranslationCache

  /**
   * Re-runs statistical BT on demand + optional AI polish. Called by the BT
   * tab's Generate/Regenerate buttons and the Polish toggle. Statistical BT is
   * always computed first; the AI step only runs when the caller requests
   * `polish` AND an AI model is configured (`isBacktranslationConfigured`).
   *
   * The Polish toggle passes its on/off state as `polish`, so turning it on
   * regenerates with AI and turning it off regenerates statistical-only —
   * keeping the displayed text in sync with the polished/statistical label.
   *
   * Auto-BT (on every target commit) uses `buildStatisticalBt` directly and
   * does NOT call this function — that path lives in handleCellCommitted and
   * commitCompletedCell (FRO-203).
   */
  const runBacktranslation = useCallback(async (cell: CellData, polish = false) => {
    if (!cell.translated?.trim()) return
    const cellId = cell.id
    setBacktranslatingState((prev) => new Set(prev).add(cellId))
    setBacktranslationErrorsState((prev) => { const n = new Map(prev); n.delete(cellId); return n })
    try {
      // Step 1: statistical gloss (always runs)
      let btText = glosser.gloss(cell.translated)
      if (!btText.trim()) {
        btText = cell.translated // last-resort literal fallback
      }

      // Step 2: AI polish — only when the caller asked for it (Polish toggle on)
      // and a model is configured. The polished result replaces the statistical
      // gloss and renders above the substring-alignment panel.
      let polished = false
      if (polish && isBacktranslationConfigured && project?.completionSettings) {
        try {
          btText = await generateBacktranslation({
            settings: project.completionSettings,
            session: frontierSession,
            sourceLanguage: project.sourceLanguage || "English",
            targetLanguage: project.targetLanguage || "Unknown",
            targetText: cell.translated,
            examples: [],
            // btseed-glue: seed terminology so the literal BT surfaces the
            // controlled-vocabulary source headwords for the renderings the
            // translator chose. The service derives the relevant hints from
            // the cell's source text; behavior is unchanged when nothing matches.
            concepts: project.terminology ?? [],
            sourceText: cell.original,
          })
          polished = true
        } catch (polishErr) {
          // Polish failed — keep statistical result, surface a non-fatal warning
          console.warn("[bt] LLM polish failed, using statistical result:", polishErr)
        }
      }

      setBacktranslationCache((prev) => new Map(prev).set(cellId, btText))
      persistBt(cell, btText, polished)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setBacktranslationErrorsState((prev) => new Map(prev).set(cellId, msg))
    } finally {
      setBacktranslatingState((prev) => { const n = new Set(prev); n.delete(cellId); return n })
    }
  }, [glosser, isBacktranslationConfigured, project?.completionSettings, project?.sourceLanguage, project?.targetLanguage, project?.terminology, frontierSession, persistBt])

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
  const canAssignWork = currentRoleLevel >= ROLE.PROJECT_LEAD
  const jwt = frontierSession?.jwt ?? null

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
      for (const cell of cells) {
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
  }, [myAssignments, cells, activeFileId, project?.id, currentUsername])

  // Merge in-memory BT cache into cells array for display.
  // Also restore localStorage BTs for cells not yet in the cache (reload recovery).
  const cellsWithBacktranslation = useMemo(() => {
    return cells.map((c) => {
      const local = backtranslationCache.get(c.id)
      if (local) {
        return { ...c, backtranslation: local, backtranslationForText: c.translated }
      }
      // Reload recovery: check localStorage
      if (!c.backtranslation && project?.id) {
        try {
          const lsKey = `bt:${project.id}:${c.id}`
          const raw = localStorage.getItem(lsKey)
          if (raw) {
            const { btText, targetEventId } = JSON.parse(raw) as {
              btText: string; targetEventId: string
            }
            return {
              ...c,
              backtranslation: btText,
              backtranslationForText: targetEventId === c.targetEventId ? c.translated : "",
            }
          }
        } catch { /* ignore */ }
      }
      return c
    })
  }, [cells, backtranslationCache, project?.id])

  const backtranslating = backtranslatingState
  const backtranslationErrors = backtranslationErrorsState

  const requiredValidations = project ? readValidationCount(project) : 1

  // AD-14: health derives from decay (endorsement_count). The legacy
  // four-sub-score "composite-health" path is retired.
  const health = useHealth(
    fileCells,
    rules,
    { decaySettings: project?.decaySettings, requiredValidations },
  )
  const { healthMap, fileHealth: _fileHealth, projectHealth, fileProgress, infractions, openCommentCount, cellOpenCommentCount } = health

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
    cells,
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
    const idx = cells.findIndex((c) => c.id === cellId)
    if (idx >= 0) editorRef.current?.scrollToCellIndex(idx)
  }, [cells])

  // FRO-192: jump to the first cell matching an assignment's scopeLabel.
  // Uses the same globalReferences prefix match as assignmentsByCellId build.
  const jumpToScopeLabel = useCallback((scopeLabel: string) => {
    const chapterPart = scopeLabel.split(" in ")[0]?.trim() ?? scopeLabel
    const chapters = chapterPart.split(",").map((s) => s.trim()).filter(Boolean)
    let idx = -1
    for (const ch of chapters) {
      idx = cells.findIndex((c) => {
        const ref = c.globalReferences?.[0] ?? ""
        const refChapter = ref.includes(":") ? ref.slice(0, ref.indexOf(":")).trim() : ref.trim()
        if (refChapter === ch) return true
        // Fallback: section match
        if (c.section === ch) return true
        return false
      })
      if (idx >= 0) break
    }
    // If no chapter match, try scopeLabel against file name (book scope)
    if (idx < 0) idx = 0  // scroll to top as best effort
    editorRef.current?.scrollToCellIndex(idx)
  }, [cells])

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
    if (!cellId || cells.length === 0) return
    const idx = cells.findIndex((c) => c.id === cellId)
    if (idx >= 0) {
      pendingCellScrollRef.current = null
      editorRef.current?.scrollToCellIndex(idx)
    }
  }, [cells])

  const drawerRule = rules.find((r) => r.id === drawerRuleId) || null
  const drawerInfractions = drawerRuleId
    ? Array.from(infractions.values()).flat().filter((i) => i.ruleId === drawerRuleId)
    : []

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
  const { peers: fileLevelPeers, status: fileSyncStatus } = useFileSync({
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
  // FRO-175: reactive version of focusedCellIdRef for the chat panel's context wiring.
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null)

  // Chat "Insert into cell": commit the reply text through the same path
  // single-cell AI completion uses (FRO-247 write-clock semantics hold).
  const handleChatInsertIntoCell = useCallback(async (text: string) => {
    if (!focusedCellId) return
    const cell = cells.find((c) => c.id === focusedCellId)
    if (!cell) return
    await commitCompletedCell(cell, text, currentUsername)
  }, [focusedCellId, cells, commitCompletedCell, currentUsername])

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

  useEffect(() => {
    if (!project?.id || !frontierSession?.jwt) return
    let cancelled = false
    let reconciler: import("@/lib/sync/ws-reconciler").WsReconciler | null = null
    void (async () => {
      const { createWsReconciler } = await import("@/lib/sync/ws-reconciler")
      const { syncWorkerHttpOrigin } = await import("@/lib/sync/sync-worker-url")
      if (cancelled || !project?.id) return
      const pid = project.id
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
          onMessage(msg) {
            if (msg.t === "event.applied") {
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
              // Targeted single-cell refetch — avoids re-streaming every
              // cell in the file for one remote change. Falls back to a
              // full revalidate inside useCells on error.
              revalidateCell(msg.cell)
              // Audio attachment events project into cell_audio (not cells);
              // poke the per-file audio read so the new clip surfaces.
              if (msg.kind?.startsWith("cell.audio.") && msg.file) {
                notifyAudioAttachmentsChanged(msg.file)
              }
              // Don't pop the "remote changed" banner for our own writes —
              // the editor just committed; bouncing the same event back via
              // WS is expected. `by` is populated by post-2c-γ sync workers;
              // older builds omit it and fall through to the legacy
              // "always banner on focused cell" path so the user can still
              // tell something happened.
              if (msg.by && msg.by === currentUsername) return
              if (focusedCellIdRef.current === msg.cell) {
                setCellsWithRemoteChange((cur) => {
                  if (cur.has(msg.cell!)) return cur
                  const next = new Set(cur)
                  next.add(msg.cell!)
                  return next
                })
              }
            } else if (msg.t === "presence") {
              // FRO-288: forward presence snapshots to the focus-lock hook so
              // it can update heldBy when another user holds our focused cell.
              focusLockFeedFrameRef.current(msg)
              // B4 fix: applyPresenceFrame always returns a NEW Map, so ref and
              // state never share the same object — subsequent handlers cannot
              // cause React's bail-out by mutating the shared instance in place.
              // RACE-5: update ref synchronously so checkLockHolder reads
              // the latest state even before the React re-render completes.
              const next = applyPresenceFrame(msg.users, currentUsername)
              cellLockHoldersRef.current = next
              setCellLockHolders(next)
            } else if (msg.t === "lock.claimed") {
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
            }
          },
        },
      )
      reconcilerRef.current = reconciler
      setLiveReconciler(reconciler)
    })()
    return () => {
      cancelled = true
      reconcilerRef.current = null
      setLiveReconciler(null)
      reconciler?.close()
    }
  }, [project?.id, frontierSession?.jwt, getTokenForFile, revalidateCells, revalidateCell, currentUsername, refresh])

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
    currentUserId: currentUsername,
  })
  const focusLockFeedFrameRef = useRef(focusLockFeedFrame)
  useEffect(() => { focusLockFeedFrameRef.current = focusLockFeedFrame }, [focusLockFeedFrame])

  const writeLocTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleClaimCell = useCallback((cellId: string) => {
    focusedCellIdRef.current = cellId
    setFocusedCellId(cellId) // FRO-175: reactive for chat panel context
    // FRO-179: update TN sidebar with the focused cell's canonicalRef.
    const focusedCell = cells.find((c) => c.id === cellId)
    setFocusedCellCanonicalRef(focusedCell?.group ?? null)
    // Parallel-bibles panel: navigating to a cell is a stronger "looking at"
    // signal than the scroll position — the panel follows whichever moved last.
    if (focusedCell?.group) setTrackedCellRef(focusedCell.group)
    // FRO-288: focusLockState.claim() replaces the bare focus.claim send.
    // The hook sends focus.claim and starts the half-period renewal timer so
    // the 30s DO lease never silently expires mid-edit.
    focusLockState.claim()
    // Debounce last-location cell write (500 ms) so rapid focus events
    // don't hammer localStorage.
    if (writeLocTimerRef.current !== null) clearTimeout(writeLocTimerRef.current)
    writeLocTimerRef.current = setTimeout(() => {
      writeLocTimerRef.current = null
      if (!projectId || !activeFileId) return
      writeLastLocation(currentUsername, projectId, { fileId: activeFileId, cellId })
    }, 500)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, activeFileId, currentUsername, focusLockState.claim])
  const handleReleaseCell = useCallback((cellId: string) => {
    if (focusedCellIdRef.current === cellId) focusedCellIdRef.current = null
    // Deliberately keep focusedCellId / focusedCellCanonicalRef: the chat
    // panel and TN sidebar need the *last* focused cell as context — clicking
    // away (e.g. to open chat) releases the focus lock but shouldn't drop the
    // context the user was just working in. Both reset on file switch below.
    // FRO-288: hook's release() sends focus.release + stops renewal timer.
    focusLockState.release()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLockState.release])
  // Last-focused context is per-file: a cell from the previous file is stale
  // once the user opens another one.
  useEffect(() => {
    setFocusedCellId(null)
    setFocusedCellCanonicalRef(null)
  }, [activeFileId])
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

  // Drives the editor-area rendering: loading skeleton vs. empty state vs.
  // EditorTable. Centralizes the decision so we don't flash between states
  // while a file hydrates.
  const cellAreaState = useMemo(
    () => deriveCellAreaState({
      activeFileId,
      cellCount: cells.length,
      syncStatus: fileSyncStatus,
      cellsLoading,
    }),
    [activeFileId, cells.length, fileSyncStatus, cellsLoading]
  )

  // Presence visible in the status bar is the file-level set the sync-worker
  // already broadcasts via awareness. We previously union'd this with a
  // separate project-wide presence room (over the legacy signaling relay) so
  // peers on other files showed up too, but the relay is gone and the
  // sync-worker doesn't fan out cross-file awareness yet — file-level only
  // for now.
  const peers = fileLevelPeers

  async function handleSearchSelect(result: WorkspaceSearchResult, query: string) {
    const flash = () => {
      const idx = cellsRef.current.findIndex((c) => c.id === result.cellId)
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
    const cell = cellsRef.current.find((candidate) => candidate.id === cellId)
    if (!cell) return

    applyOptimisticTargetEditWithCapture(cell.id, { value: updatedText, valueHtml: updatedText })
    await emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      parentId: cell.targetEventId ?? cell.sourceEventId ?? null,
      sourceEventId: cell.sourceEventId ?? null,
      value: updatedText,
      valueHtml: updatedText,
      author: currentUsername,
    })
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    revalidateAuditStats()
    revalidateCell(cell.id)
  }, [
    project?.id,
    project?.syncRole?.level,
    isReadOnly,
    applyOptimisticTargetEditWithCapture,
    currentUsername,
    getTokenForProjectFile,
    refreshOutboxPending,
    revalidateAuditStats,
    revalidateCell,
  ])

  const handleTrayFootnoteSave = useCallback((cellId: string, footnoteIndex: number, newText: string) => {
    const cell = cellsRef.current.find((candidate) => candidate.id === cellId)
    if (!cell) return
    const updated = spliceFootnoteText(cell.translated ?? "", footnoteIndex, newText)
    void commitTrayFootnoteText(cellId, updated)
  }, [commitTrayFootnoteText])

  const handleTrayFootnoteDelete = useCallback((cellId: string, footnoteIndex: number) => {
    const cell = cellsRef.current.find((candidate) => candidate.id === cellId)
    if (!cell) return
    const updated = deleteFootnote(cell.translated ?? "", footnoteIndex)
    void commitTrayFootnoteText(cellId, updated)
  }, [commitTrayFootnoteText])

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
    try {
      await emitFileDelete({
        projectId: project.id,
        fileId,
        author: currentUsername,
      })
      // Remove from local IDB only after the event is enqueued (server ack path).
      await patchProject(project.id, (p) => deleteFile(p, fileId))
    } catch (e) {
      console.error("[delete] file.delete emit failed", e)
      // Do not remove from local IDB if the event failed to enqueue.
      return
    }
    // Hide the row immediately — the server read won't reflect file.delete
    // until the outbox flushes, and refresh() below would otherwise re-fetch
    // the file straight back into the sidebar.
    setOptimisticDeletes((current) => {
      const next = new Set(current)
      next.add(fileId)
      return next
    })
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
    const next = applySuggestions(project, chosen)
    // Optimistic: surface new labels instantly and drop applied files from the banner.
    setOptimisticRenames((current) => {
      const map = new Map(current)
      for (const s of chosen) map.set(s.fileId, s.suggestedName)
      return map
    })
    setClientProject(next)
    // Persist corpus/originalName locally (server file.rename only carries name).
    await updateProject(next)
    const nameChanges = chosen.filter((s) => s.currentName !== s.suggestedName)
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
        console.error("[rename] file.rename emit failed during suggestion apply", e)
      }
    }
    refresh()
    setUndo({ chosen })
    setTimeout(() => setUndo((u) => (u?.chosen === chosen ? null : u)), 10000)
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
    const byId = new Map(allProjectCells.map((c) => [c.id, c]))
    const touched: string[] = []
    for (const diff of payload.diffs) {
      const cell = byId.get(diff.cellId)
      if (!cell) continue
      if (cell.fileId === activeFileId) applyOptimisticTargetEdit(cell.id, { value: diff.after })
      await emitTargetCellCommit({
        projectId: project.id,
        fileId: cell.fileId,
        cellId: cell.id,
        parentId: cell.targetEventId ?? cell.sourceEventId ?? null,
        sourceEventId: cell.sourceEventId ?? null,
        value: diff.after,
        author: currentUsername,
        searchQuery: payload.findQuery,
        replaceString: payload.replaceQuery,
      })
      touched.push(cell.id)
    }
    if (touched.length === 0) return
    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    revalidateAuditStats()
    for (const id of touched) {
      if (byId.get(id)?.fileId === activeFileId) revalidateCell(id)
    }
    rebuildSearchIndex()
  }, [project?.id, isReadOnly, allProjectCells, activeFileId, applyOptimisticTargetEdit, currentUsername, getTokenForProjectFile, refreshOutboxPending, revalidateAuditStats, revalidateCell, rebuildSearchIndex])

  const projectNavItems = useMemo(() => {
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
      // SWARM-TODO(voice-a7): "Voice" nav button toggles the Audio/Text lens
      // (current intentional behavior, fixed in a prior wave to avoid the
      // one-way-trap). QA now reports this is AMBIGUOUS: users expect a nav
      // button to navigate to a Voice settings page, not to toggle a lens mode.
      // Product decision needed:
      //   Option A: Keep as lens toggle but rename/re-icon it (e.g. "Audio lens"
      //             with a headphones icon) so it's clear it's a VIEW mode switch.
      //   Option B: Make "Voice" open a dedicated /project/:id/voice settings page
      //             (requires adding a route + VoiceStudioPage component) and put
      //             the lens toggle in the header bar only.
      //   Option C: Two-step: first click = switch to Audio lens, second click
      //             while in Audio lens = open voice settings modal.
      // See: src/components/ProjectWorkspace.tsx (this file), src/App.tsx (routes)
      { id: "voice-studio", label: "Voice", icon: Mic2,
        onClick: () => setLens(lens === "audio" ? "text" : "audio") },
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
  }, [projectId, activeFileId, navigate, openCommentCount, lens, setLens, currentRoleLevel])

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
    if (cells.length === 0) return
    let cancelled = false
    void eagerlyPrefetchPeaks({
      cells, project, session: frontierSession, bins: 320,
      isCancelled: () => cancelled,
    })
    return () => { cancelled = true }
  }, [project, cells, frontierSession])

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
    // If org policy disallows export (explicit floor set and user below it), no-op.
    if (!canExportByOrgPolicy) return
    setExportOpen(true)
  }, [orgSettingsFetched, canExportByOrgPolicy])

  const actionArgs = useMemo(() => ({
    openImport: openImportFlow,
    runCompletions: () => {
      if (!activeFileId) return
      const untranslated = cells.filter((c) => !c.translated.trim())
      if (untranslated.length === 0) return
      completeBatch(untranslated.slice(0, MAX_BATCH_COMPLETIONS))
    },
    runCompleteAll: () => {
      if (!activeFileId) return
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
      const validatable = cells.filter(
        (c) => c.fileId === activeFileId && !!c.targetEventId,
      )
      if (validatable.length === 0) return
      void (async () => {
        for (const cell of validatable) {
          await emitCellValidate({
            projectId: project.id,
            fileId: cell.fileId,
            cellId: cell.id,
            editEventId: cell.targetEventId!,
            author: currentUsername,
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
      void runBatchTranscribeAll({
        cells,
        projectId: project.id,
        session: frontierSession ?? null,
        language: project.sourceLanguage,
      })
    },
    runSynthAll: () => {
      if (!activeFileId || !project) return
      void runBatchSynthAll({
        cells,
        project,
        session: frontierSession ?? null,
        username: currentUsername,
      })
    },
    navigate,
  }), [activeFileId, completeBatch, cells, project, frontierSession, currentUsername, navigate, openImportFlow, openExportFlow, getTokenForProjectFile, refreshOutboxPending, revalidateAuditStats, revalidateCell])

  const handleCellCommitted = useCallback(async (cellId?: string) => {
    // Capture before async work — another edit could arrive during the flush.
    const pendingBt = lastOptimisticEditRef.current
    lastOptimisticEditRef.current = null

    await flushOutboxBatch({ getTokenForFile: getTokenForProjectFile })
    await refreshOutboxPending()
    revalidateAuditStats()
    // Targeted: a hand edit / validate / waive touches exactly one cell. Pull
    // only that row instead of re-streaming the whole file. Fall back to a full
    // revalidate if the caller didn't pass a cellId (older call sites).
    const changed = cellId ?? pendingBt?.cellId
    if (changed) revalidateCell(changed)
    else revalidateCells()

    // ── Auto statistical BT on target commit (FRO-203) ─────────────────────
    // Run synchronously after the flush so the BT reflects the committed text.
    // LLM polish is NOT triggered here — it remains opt-in via runBacktranslation.
    // Uses stable refs so this callback doesn't need glosser/cells/persistBt
    // in its dep array (they are declared earlier or later in hook order).
    if (pendingBt?.translatedText && glosserRef.current && setBacktranslationCacheRef.current) {
      const { cellId, translatedText } = pendingBt
      const btText = buildStatisticalBt(glosserRef.current, translatedText)
      if (btText) {
        const cell = cellsRef.current.find((c) => c.id === cellId)
        setBacktranslationCacheRef.current((prev) => new Map(prev).set(cellId, btText))
        if (cell && persistBtRef.current) {
          persistBtRef.current(cell, btText, false)
        }
      }
    }
  }, [getTokenForProjectFile, refreshOutboxPending, revalidateAuditStats, revalidateCell, revalidateCells])

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
            setDirectionRoleNotice(
              "Your direction choice couldn't be saved project-wide — it needs a maintainer. It will apply locally.",
            )
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
    if (refs.length > 0) workspaceTabs.openFile(refs[0].id)
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
      <ScrollToGroupHandler cells={cells} editorRef={editorRef} />
      {/* FRO-308: currentCell for chat panel — derived from focusedCellId */}
      <AppShell
        logoAccessory={
          dockTab !== null ? (
            <AppTooltip content="Collapse sidebar" side="right">
              <button
                type="button"
                aria-label="Collapse sidebar"
                onClick={() => setDockTab(null)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </AppTooltip>
          ) : null
        }
        leftDock={
          <LeftDock
            storageKey={projectId}
            activeTab={dockTab}
            onActiveTabChange={setDockTab}
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
                  activeFileId={activeFileId}
                  fileProgress={fileProgress}
                  suggestionFileIds={suggestionFileIds}
                  validationCount={validationCount}
                  getTokenForFile={getTokenForFile}
                  onSelectFile={workspaceTabs.openFile}
                  onRename={handleRename}
                  onMove={(fileId) => {
                    setMoveTargetId(fileId)
                    setMoveCorpus(project.files.find((f) => f.id === fileId)?.corpusMarker ?? "")
                  }}
                  onDelete={currentRoleLevel >= ROLE.PROJECT_LEAD ? (fileId) => setPendingDeleteId(fileId) : undefined}
                  onApplySuggestion={handleApplyOneSuggestion}
                  onRenameCorpus={handleRenameCorpus}
                  canExportByOrgPolicy={canExportByOrgPolicy}
                />
                {lens === "audio" && project && (
                  <VoiceSidebar
                    cells={cells}
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
                )}
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
                <div className="mt-auto border-t px-2 pb-2 pt-2">
                  {/* Contextual onboarding status — self-removes once setup
                      completes. Sidebar-footer placement (Linear-style) keeps
                      transient onboarding state out of the action header. */}
                  {checklistState.totalCount > 0 && checklistState.completedCount < checklistState.totalCount && (
                    <TooltipProvider delay={0}>
                      <Tooltip open={showChipTooltip} onOpenChange={setShowChipTooltip}>
                        <TooltipTrigger
                          render={
                            <button
                              onClick={() => { setShowChipTooltip(false); setChecklistOpen(true) }}
                              className="mb-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
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
                    </TooltipProvider>
                  )}
                  <AccountSwitcher variant="sidebar" />
                </div>
              </div>
            }
            chatPanel={
              <ChatDockPanel
                chat={chat}
                onInsertIntoCell={handleChatInsertIntoCell}
                currentCell={(() => {
                  if (!focusedCellId) return null
                  const cell = cells.find((c) => c.id === focusedCellId)
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
                bibleResourcesEnabled={Boolean(project.bibleResourcesEnabled)}
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
            onBack={goToProjects}
            extraMenuItems={workspaceHeaderMenuItems}
          >
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
                  cells={cells}
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

            <PrimaryActionButton ctx={actionCtx} run={actionArgs} />

            {/* FRO-331: hidden trigger — opened from ⋯ menu; keeps RTL hint anchored here. */}
            <ViewSettingsMenu
              ref={viewSettingsRef}
              hideTrigger
              fileOpen={Boolean(activeFileId)}
              lineNumbersEnabled={fileMeta.lineNumbersEnabled}
              sourceTextDirection={fileMeta.sourceTextDirection}
              targetTextDirection={fileMeta.targetTextDirection}
              cellLabelsEnabled={cellLabelsEnabled}
              footnoteViewMode={footnoteViewMode}
              onFootnoteViewModeChange={setFootnoteViewMode}
              tnSidebarEnabled={tnSidebarVisible}
              rtlHintDismissed={fileMeta.rtlHintDismissed}
              sourceFontSize={fontSizes.source}
              targetFontSize={fontSizes.target}
              onLineNumbersChange={fileMeta.setLineNumbersEnabled}
              onSourceTextDirectionChange={fileMeta.setSourceTextDirection}
              onTargetTextDirectionChange={fileMeta.setTargetTextDirection}
              onCellLabelsChange={setCellLabelsEnabled}
              onSourceFontSizeChange={(v) => { if (activeFileId) setFileViewPref(activeFileId, { sourceFontSize: v }) }}
              onTargetFontSizeChange={(v) => { if (activeFileId) setFileViewPref(activeFileId, { targetFontSize: v }) }}
              onTnSidebarChange={(v) => {
                setTnSidebarVisible(v)
                if (projectId) writeTnSidebarVisible(projectId, v)
              }}
              onDismissRtlHint={fileMeta.dismissRtlHint}
            />
          </WorkspaceHeader>
        }
        beforeMain={
          <>
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
              trailing={
                // Per-file view-mode control — lives with the content it
                // affects, not in the global header (which holds actions).
                project && centerSurface === "editor" && activeFileId ? (
                  <EditorModeToggle
                    lens={lens}
                    onChange={(l) => setLens(l)}
                    timeOrdered={activeFile ? fileOrderedBy(activeFile) === "time" : false}
                  />
                ) : undefined
              }
            />
            {project && activeFileId && (
              <>
                <SelectionBar
                  project={project}
                  cells={cells}
                  session={frontierSession}
                  username={currentUsername}
                  completeSingle={completeSingle}
                  completeBatch={completeBatch}
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
            {isSubtitleFile && videoSrc && (
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
            cells={cells}
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
              <TerminologyPageContent />
            </Suspense>
          </div>
        ) : centerSurface === "members" ? (
          // FRO-180: Per-project members management inside the shell.
          <div className="h-full overflow-y-auto">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading members…</div>}>
              <ProjectMembersPageContent />
            </Suspense>
          </div>
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
              <EditorTable
            ref={editorRef} project={project} cells={cellsWithBacktranslation}
            showFootnotesInline={footnoteViewMode === "inline"}
            footnotePanelActive={footnoteViewMode !== "off"}
            onVisibleFootnotesChange={footnoteViewMode === "tray" ? handleVisibleFootnotesChange : undefined}
            username={currentUsername}
            isCompletionConfigured={isConfigured} isCompletionAvailable={isCompletionAvailable} completing={completing}
            examples={examples} errors={errors} previews={previews}
            onCompleteSingle={completeSingle} onCompleteBatch={completeBatch}
            healthMap={effectiveHealthMap} infractions={infractions} rules={rules}
            onInfractionClick={(ruleId) => {
              setCommentsCellId(null); setHistoryCellId(null); setDrawerRuleId(ruleId)
            }}
            isBacktranslationConfigured={isBacktranslationConfigured}
            onBacktranslate={runBacktranslation}
            onSaveBacktranslation={saveBacktranslation}
            backtranslating={backtranslating}
            backtranslationErrors={backtranslationErrors}
            cellOpenCommentCount={cellOpenCommentCount}
            onOpenComments={(cellId) => {
              setDrawerRuleId(null); setHistoryCellId(null); setCommentsCellId(cellId)
            }}
            onOpenHistory={(cellId) => {
              setDrawerRuleId(null); setCommentsCellId(null); setHistoryCellId(cellId)
            }}
            getTokenForFile={getTokenForFile}
            alignmentModel={alignmentModel}
            onAlignmentSeedChange={handleAlignmentSeedChange}
            activeCueIndex={activeCueIndex >= 0 ? activeCueIndex : undefined}
            onSeekToCue={isSubtitleFile ? handleCueSeek : undefined}
            lineNumbersEnabled={fileMeta.lineNumbersEnabled}
            cellLabelsEnabled={cellLabelsEnabled}
            sourceTextDirection={fileMeta.sourceTextDirection}
            targetTextDirection={fileMeta.targetTextDirection}
            isAnonymous={!frontierSession}
            onJumpToCell={jumpToCellId}
            onAiSetupNeeded={() => setAiSetupOpen(true)}
            audioLens={audioLens}
            orderedBy={activeFile ? fileOrderedBy(activeFile) : undefined}
            onOpenAudioSetup={openAudioSetup}
            onOpenRecording={(cellId) => setRecordingCellId(cellId)}
            onAssignVoice={async (cellId, voiceId) => {
              if (!audioProject || !frontierSession) return
              // First assign the voice to this cell in the cast
              tts.assignCells([cellId], voiceId)
              // Then synthesise with the newly assigned voice
              const targetCell = cells.find((c) => c.id === cellId)
              if (!targetCell) return
              const ok = await generateCellVoice({
                project: audioProject,
                cell: targetCell,
                session: frontierSession,
                username: currentUsername,
                voiceId,
              })
              if (ok) refresh()
            }}
            onProjectChanged={refresh}
            onAddConceptFromSelection={handleAddConceptFromSelection}
            onAttachMediaFile={handleAttachMediaFile}
            onAttachMediaUrl={handleAttachMediaUrl}
            onCellCommitted={handleCellCommitted}
            onOptimisticEdit={applyOptimisticTargetEditWithCapture}
            cellLockHolders={cellLockHolders}
            cellsWithRemoteChange={cellsWithRemoteChange}
            onClaimCell={handleClaimCell}
            onReleaseCell={handleReleaseCell}
            onAckRemoteChange={handleAckRemoteChange}
            checkLockHolder={checkLockHolder}
            staleCellIds={staleCellIds}
            assignmentsByCellId={assignmentsByCellId}
            onVisibleRefChange={setTrackedCellRef}
          />
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
            {drawerRuleId && (
              <RuleDrawer
                rule={drawerRule}
                infractions={drawerInfractions}
                cells={cells}
                onClose={() => setDrawerRuleId(null)}
                onNavigateToCell={() => {}}
                project={project}
                username={currentUsername}
                refresh={refresh}
                cellsByFile={fileCells}
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
                onPromote={handlePromoteToCurrentCell}
              />
            )}
          </>
        }
        statusBar={
          <>
            <WorkspaceStatusBar
              left={
                <div className="flex items-center gap-3">
                  <PeerPresence peers={peers} />
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
            <StatusBar
              cells={cells}
              projectHealth={projectHealth}
              healthMap={healthMap}
              staleSourceCount={staleCellIds.size}
              onJumpToCell={jumpToCellId}
            />
          </>
        }
      />
      {project && (
        <SetupChecklistDrawer
          open={checklistOpen}
          onOpenChange={handleChecklistOpenChange}
          project={project}
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
          members={projectMembers}
          roleLevel={currentRoleLevel}
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
          cells={cells}
          activeCellId={recordingCellId}
          username={currentUsername}
          onActiveCellChange={(cellId) => {
            setRecordingCellId(cellId)
            // Scroll the underlying editor to the new cell so the row is visible
            // when the modal closes.
            const idx = cells.findIndex((c) => c.id === cellId)
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
          existingFiles={project.files} />
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
            onImported={() => revalidateCells()}
          />
        </Suspense>
      )}
      {/* FRO-249/FRO-255 fix (Fix 4): transient notice when direction couldn't be saved project-wide */}
      {directionRoleNotice && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-4 z-60 max-w-sm rounded border bg-background px-3 py-2 text-sm text-foreground shadow-md"
        >
          {directionRoleNotice}
        </div>
      )}
      <Suspense fallback={null}>
        <ExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          canExport={canExportByOrgPolicy}
          cells={cells}
          projectId={project.id}
          projectName={project.name ?? project.id}
          activeFileId={activeFileId ?? null}
          activeFileName={activeFile?.name ?? null}
          isUsfmFile={activeFile?.type === "usfm"}
          isDocxFile={activeFile?.type === "docx"}
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
      {/* FRO-175: AI chat panel */}
      <ChatPanel
        open={chatOpen}
        onOpenChange={setChatOpen}
        chat={chat}
        onInsertIntoCell={handleChatInsertIntoCell}
        currentCell={(() => {
          if (!focusedCellId) return null
          const cell = cells.find((c) => c.id === focusedCellId)
          if (!cell) return null
          return {
            sourceText: cell.original,
            translatedText: cell.translated,
            context: cell.context ?? undefined,
          }
        })()}
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
        <div className="fixed bottom-4 right-4 z-60 flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-sm shadow-neu">
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
          className="neu-inset w-full rounded px-2 py-1.5 text-sm"
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
            className="neu-inset mt-2 w-full rounded px-2 py-1 text-sm"
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
  cells: CellData[]
  editorRef: React.RefObject<EditorTableHandle | null>
}

function ScrollToGroupHandler({ cells, editorRef }: ScrollToGroupHandlerProps) {
  const editorScroll = useEditorScroll()

  useEffect(() => {
    const pending = editorScroll.pending
    if (!pending) return
    const { group: groupId, section: sectionLabel, fileId: targetFileId } = pending

    // FRO-250/254: only consume() when the current cells belong to the requested
    // file. During a file-switch the cells array may still reflect the OLD file
    // while the pending request already carries the NEW file's id — consuming
    // early would match against stale cells and either scroll nowhere or jump to
    // the wrong verse, then burn the request before the new file's cells arrive.
    const currentFileId = cells[0]?.fileId ?? null
    if (targetFileId !== null && currentFileId !== targetFileId) {
      // Leave the request pending until cells have been replaced.
      return
    }

    editorScroll.consume()
    if (!groupId && !sectionLabel) return

    let idx = -1
    if (sectionLabel) {
      // Match by section label first (e.g. "GEN 1")
      idx = cells.findIndex((c) => c.section === sectionLabel)
      // Fallback: match by group
      if (idx < 0) idx = cells.findIndex((c) => (c.group ?? "Ungrouped") === sectionLabel)
      // FRO-250: match by globalReferences prefix — the sidebar's chapter labels
      // are derived as "BOOK CH" from the first globalReference (e.g. "GEN 1"
      // from "GEN 1:1"), so we match the first cell whose first ref starts with
      // "LABEL:" or equals LABEL exactly. This lets sidebar chapter clicks scroll
      // to the right verse even when cells have no explicit `section` field.
      if (idx < 0) {
        idx = cells.findIndex((c) => {
          const ref = c.globalReferences?.find((r) => r && r.trim().length > 0)
          if (!ref) return false
          const colonIdx = ref.indexOf(":")
          const prefix = (colonIdx >= 0 ? ref.slice(0, colonIdx) : ref).trim()
          return prefix === sectionLabel
        })
      }
    } else if (groupId) {
      idx = cells.findIndex((c) => (c.group ?? "Ungrouped") === groupId)
    }

    if (idx >= 0) {
      // Defer a tick so the virtualizer has the latest cell list after any
      // file-switch that preceded this request.
      setTimeout(() => {
        editorRef.current?.scrollToCellIndex(idx)
      }, 0)
    }
  }, [cells, editorScroll, editorRef])

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
      <div className="neu-raised max-w-md rounded-2xl p-8 text-center">
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
