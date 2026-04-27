import { useState, useMemo, useRef, useEffect, useCallback } from "react"
import * as Y from "yjs"
import { useParams, useNavigate, useSearchParams } from "react-router-dom"
import { useProject } from "@/hooks/useProject"
import { useFileDoc } from "@/hooks/useFileDoc"
import { deriveCellAreaState } from "@/lib/editor/cell-area-state"
import { CellAreaPlaceholder } from "./CellAreaPlaceholder"
import { TabStrip } from "./TabStrip"
import { useWorkspaceTabs } from "@/hooks/useWorkspaceTabs"
import { useCells } from "@/hooks/useCells"
import { useSearchIndex } from "@/hooks/useSearchIndex"
import { useCompletion } from "@/hooks/useCompletion"
import { useHealth } from "@/hooks/useHealth"
import { useRules } from "@/hooks/useRules"
import { updateProject, patchProject, getProject } from "@/lib/store/project-index"
import { exportFile, downloadBlob } from "@/lib/export/export-service"
import type { FileReference, CellHealthBreakdown } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { useWorkspaceSearch } from "@/hooks/useWorkspaceSearch"
import { useBacktranslation } from "@/hooks/useBacktranslation"
import { useComments } from "@/hooks/useComments"
import { SearchDialog } from "./SearchDialog"
import { ParallelPassagesPanel, type ParallelPanelMode, type ParallelPanelScope } from "./ParallelPassagesPanel"
import type { EditorTableHandle } from "./EditorTable"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"
import { StatusBar } from "./StatusBar"
import { SyncStatusIndicator } from "./SyncStatusIndicator"
import { ImportDialog } from "./ImportDialog"
import { EditorTable } from "./EditorTable"
import { AudioRecordingModal } from "./AudioRecorder/AudioRecordingModal"
import { RuleDrawer } from "./RuleDrawer"
import { CommentsDrawer } from "./CommentsDrawer"
import { HistoryDrawer } from "./HistoryDrawer"
import { SharePanel } from "./SharePanel"
import { VideoPlayer, type VideoPlayerHandle } from "./VideoPlayer"
import { ResizableVideoPanel } from "./ResizableVideoPanel"
import { VideoAttachmentDialog } from "./VideoAttachmentDialog"
import { useVideoAttachment } from "@/hooks/useVideoAttachment"
import { parseTimestampRange, extractCuesFromCells } from "@/lib/video/vtt-generator"
import { useSync } from "@/hooks/useSync"
import { useFileSync } from "@/hooks/useFileSync"
import { useProjectTombstoneObserver } from "@/hooks/useProjectTombstoneObserver"
import { useFileMeta } from "@/hooks/useFileMeta"
import { useCellLabelsPreference } from "@/hooks/useCellLabelsPreference"
import { peerColor as peerColorLocal } from "@/lib/sync/signaling-provider"
import { displayNameFor } from "@/lib/sync/anonymous-name"
import { startBootstrapHost } from "@/lib/sync/bootstrap"
import { listShares } from "@/lib/sync/share-tokens"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { useSyncProject } from "@/hooks/useSyncProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useAutoSync } from "@/hooks/useAutoSync"
import { useCorpusBackfill } from "@/hooks/useCorpusBackfill"
import { Film, Scale, MessagesSquare, Camera, Share2, Settings as SettingsIcon, Lock, ClipboardList, Brain, Trash2, Undo2 } from "lucide-react"
import { restoreProject } from "@/lib/store/project-index"
import { AppShell } from "./AppShell"
import { WorkspaceHeader } from "./WorkspaceHeader"
import { WorkspaceStatusBar } from "./WorkspaceStatusBar"
import { PrimaryActionButton } from "./PrimaryActionButton"
import { AccountSwitcher } from "./AccountSwitcher"
import { ExpandableFileList } from "./ExpandableFileList"
import { SidebarProjectSection } from "./SidebarProjectSection"
import { SidebarCommandPaletteHint } from "./SidebarCommandPaletteHint"
import { SuggestionBanner } from "./SuggestionBanner"
import { ConfirmActionDialog } from "./ConfirmActionDialog"
import { PeerPresence } from "./PeerPresence"
import { SyncButton } from "./SyncButton"
import { ViewSettingsMenu } from "./ViewSettingsMenu"
import { EditorScrollProvider, useEditorScroll } from "@/context/EditorScrollContext"
import { detectSuggestions, type RenameSuggestion } from "@/lib/file-labeling/detect"
import { applySuggestions } from "@/lib/file-labeling/apply"
import { renameFile, moveFileToCorpus, deleteFile } from "@/lib/store/file-operations"
import { deleteFileProjection } from "@/lib/sync/file-projection"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import type { ProjectRecord } from "@/lib/parsers/types"
import { readValidationCount } from "@/lib/progress/read-validation-count"
import { resolveHealthConfig } from "@/lib/health/config-resolver"
import { useSetupChecklist } from "@/hooks/useSetupChecklist"
import { SetupChecklistDrawer } from "./onboarding/SetupChecklistDrawer"
import { useFeatureFlag } from "@/hooks/useFeatureFlag"
import { NextUnfinishedButton } from "./NextUnfinishedButton"
import { useNextUnfinished } from "@/hooks/useNextUnfinished"
import { AiSetupDialog } from "./AiSetupDialog"

export function ProjectWorkspace() {
  const { id: projectId, fileId: routeFileId } = useParams<{ id: string; fileId?: string }>()
  const navigate = useNavigate()
  const { project, status, refresh } = useProject(projectId!)

  const activeFileId = routeFileId ?? null

  const setActiveFileId = useCallback((fileId: string | null) => {
    if (!projectId) return
    if (fileId) {
      navigate(`/project/${projectId}/file/${fileId}`)
    } else {
      navigate(`/project/${projectId}`)
    }
  }, [projectId, navigate])
  const projectFiles = project?.files ?? []
  const fileIds = useMemo(() => projectFiles.map((f) => f.id), [projectFiles])
  const workspaceTabs = useWorkspaceTabs({
    projectId: projectId ?? "",
    fileIds,
    activeFileId,
    setActiveFileId,
  })
  const [importOpen, setImportOpen] = useState(false)
  const [drawerRuleId, setDrawerRuleId] = useState<string | null>(null)
  const [searchParams] = useSearchParams()
  useEffect(() => {
    const open = searchParams.get("openRule")
    if (open) setDrawerRuleId(open)
  }, [searchParams])
  const [commentsCellId, setCommentsCellId] = useState<string | null>(null)
  const [historyCellId, setHistoryCellId] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [parallelOpen, setParallelOpen] = useState(false)
  const [parallelMode, setParallelMode] = useState<ParallelPanelMode>("search")
  const [parallelScope, setParallelScope] = useState<ParallelPanelScope>("project")
  const [shareOpen, setShareOpen] = useState(false)
  const [activeShareToken, setActiveShareToken] = useState<string | null>(null)
  const [shareRefreshKey, setShareRefreshKey] = useState(0)
  const [aiSetupOpen, setAiSetupOpen] = useState(false)
  const [recordingCellId, setRecordingCellId] = useState<string | null>(null)
  const editorRef = useRef<EditorTableHandle>(null)
  const { doc, loading: docLoading } = useFileDoc(activeFileId)
  // Prefer the Frontier session username (authenticated identity) over the
  // project-level username setting. Validation entries and edit history
  // should attribute to the actual signed-in user.
  const { session: frontierSession } = useFrontierSession()
  const currentUsername = frontierSession?.username || project?.username || "local"
  const validationCount = project ? readValidationCount(project) : 1
  const cells = useCells(doc, activeFileId ?? "", currentUsername, validationCount)
  const { hasAny: hasUnfinished, findNext: findNextUnfinished } = useNextUnfinished(cells, validationCount)
  const handleJumpNextUnfinished = useCallback(() => {
    const currentIndex = editorRef.current?.getCurrentIndex?.() ?? 0
    const next = findNextUnfinished(currentIndex)
    if (next >= 0) editorRef.current?.scrollToCellIndex(next)
  }, [findNextUnfinished])
  const fileMeta = useFileMeta(doc, project?.sourceLanguage, project?.targetLanguage)
  const [cellLabelsEnabled, setCellLabelsEnabled] = useCellLabelsPreference(projectId!)

  const activeFile = activeFileId ? project?.files.find((f) => f.id === activeFileId) : null
  const isSubtitleFile = activeFile?.type === "vtt" || activeFile?.type === "srt"

  const [videoDialogOpen, setVideoDialogOpen] = useState(false)
  const [currentVideoTime, setCurrentVideoTime] = useState(0)
  const videoPlayerRef = useRef<VideoPlayerHandle>(null)
  const { attachment: videoAttachment, resolvedSrc: videoSrc, blobUnavailable, save: saveVideo } =
    useVideoAttachment(isSubtitleFile ? doc : null)

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

  const { buildIndex, rebuild: rebuildSearchIndex, search: runSearch, results: searchResults, loading: searchLoading, ready: searchReady } = useWorkspaceSearch(project?.files || [])

  const { rules, penalties } = useRules(project ?? null, refresh)
  const { addThread, addMessage, resolveThread, reopenThread } = useComments(doc, currentUsername)
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

  const { search } = useSearchIndex(project?.files || [], allProjectCells)
  const { completeSingle, completeBatch, isConfigured, isAvailable: isCompletionAvailable, completing, examples, errors } = useCompletion(
    doc, project?.completionSettings, project?.sourceLanguage || "", project?.targetLanguage || "", search, frontierSession
  )

  const findBacktranslationExamples = useCallback((target: CellData) => {
    return cells
      .filter((c) => c.id !== target.id && c.backtranslation && c.backtranslationForText === c.translated)
      .map((c) => ({ target: c.translated, backtranslation: c.backtranslation! }))
      .slice(0, 3)
  }, [cells])

  const {
    generate: runBacktranslation,
    generating: backtranslating,
    errors: backtranslationErrors,
    isConfigured: isBacktranslationConfigured,
  } = useBacktranslation(
    doc,
    project?.completionSettings,
    project?.sourceLanguage || "",
    project?.targetLanguage || "",
    findBacktranslationExamples,
    frontierSession,
  )

  const compositeFlag = useFeatureFlag("composite-health", project ?? null)
  const healthConfig = useMemo(() => resolveHealthConfig(project ?? null), [project])
  const requiredValidations = project ? readValidationCount(project) : 1

  const health = useHealth(
    fileCells,
    project?.completionSettings?.llmHealthPenalty ?? 0.1,
    rules,
    penalties,
    { composite: compositeFlag, compositeConfig: healthConfig, requiredValidations },
  )
  const { healthMap, fileHealth: _fileHealth, projectHealth, fileProgress, infractions, openCommentCount, cellOpenCommentCount } = health

  const projectBreakdown: CellHealthBreakdown | undefined = useMemo(() => {
    if (!compositeFlag) return undefined
    const bs = Array.from(health.breakdownMap.values())
    if (bs.length === 0) return undefined
    const avg = (f: (b: CellHealthBreakdown) => number) =>
      Math.round(bs.reduce((a, b) => a + f(b), 0) / bs.length)
    return {
      cellId: "__project__",
      score: health.projectHealth,
      validationGap: avg((b) => b.validationGap),
      ancestryPenalty: avg((b) => b.ancestryPenalty),
      neighborhoodPenalty: avg((b) => b.neighborhoodPenalty),
      rulePenalty: avg((b) => b.rulePenalty),
      signals: {
        validatorCount: 0,
        requiredValidations: requiredValidations,
        ancestryExamples: bs
          .flatMap((b) => b.signals.ancestryExamples)
          .sort((a, b) => b.health - a.health)
          .slice(0, 5),
        neighborhoodSourceCellIds: [],
        neighborhoodTargetCellIds: [],
        idJaccard: 0,
        tfidfTokenOverlap: 0,
        infractions: [],
      },
    }
  }, [compositeFlag, health, requiredValidations])

  const biggestDrags = useMemo(() => {
    if (!compositeFlag) return undefined
    const entries: Array<{ cellId: string; score: number }> = []
    for (const b of health.breakdownMap.values()) {
      entries.push({ cellId: b.cellId, score: b.score })
    }
    entries.sort((a, b) => a.score - b.score)
    return entries.slice(0, 3)
  }, [compositeFlag, health.breakdownMap])

  const jumpToCellId = useCallback((cellId: string) => {
    const idx = cells.findIndex((c) => c.id === cellId)
    if (idx >= 0) editorRef.current?.scrollToCellIndex(idx)
  }, [cells])

  const drawerRule = rules.find((r) => r.id === drawerRuleId) || null
  const drawerInfractions = drawerRuleId
    ? Array.from(infractions.values()).flat().filter((i) => i.ruleId === drawerRuleId)
    : []

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setSearchOpen(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        if (!activeFileId || !hasUnfinished) return
        e.preventDefault()
        handleJumpNextUnfinished()
      }
      // Parallel passages shortcuts mirror codex-editor:
      //   Cmd/Ctrl+F        → search in current file
      //   Cmd/Ctrl+Shift+F  → search across all files
      //   Cmd/Ctrl+Shift+R  → search + replace across all files
      const key = e.key.toLowerCase()
      if ((e.metaKey || e.ctrlKey) && !e.altKey && key === "f") {
        e.preventDefault()
        setParallelMode("search")
        setParallelScope(e.shiftKey ? "project" : activeFileId ? "file" : "project")
        setParallelOpen(true)
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

  useEffect(() => {
    if (!project || !routeFileId) return
    const exists = project.files.some((f) => f.id === routeFileId)
    if (!exists) {
      navigate(`/project/${projectId}`, { replace: true })
    }
  }, [project, routeFileId, projectId, navigate])

  useEffect(() => {
    if (!project) {
      setActiveShareToken(null)
      return
    }
    listShares(project.id).then((shares) => {
      setActiveShareToken(shares[0]?.token || null)
    })
  }, [project?.id, shareRefreshKey])

  useEffect(() => {
    if (!project || !activeShareToken) return
    let stopFn: (() => void) | null = null
    let cancelled = false
    ;(async () => {
      const shares = await listShares(project.id)
      const activeShare = shares.find((s) => s.token === activeShareToken)
      if (!activeShare || cancelled) return
      const host = startBootstrapHost(activeShare, project)
      stopFn = host.stop
      if (cancelled) host.stop()
    })()
    return () => {
      cancelled = true
      if (stopFn) stopFn()
    }
  }, [project, activeShareToken])

  // Always-on file sync via the codex sync-worker (y-partyserver DO + R2).
  // Unlike the previous share-token-gated path, this keeps every open file
  // in lockstep across devices for the same user too, not just collaborators.
  const { peers: fileLevelPeers, provider: syncProvider, status: fileSyncStatus } = useFileSync({
    doc,
    projectId: project?.id ?? null,
    fileId: activeFileId || null,
    username: currentUsername,
    enabled: Boolean(project && activeFileId && doc),
    session: frontierSession,
    projectName: project?.name ?? null,
    gitlabProjectId:
      project?.origin?.kind === "git" ? project.origin.gitlabProjectId : null,
  })

  // When the owner archives the project, the sync-worker DO flips
  // meta.projectDeletedAt; this observer reconciles IDB so the
  // TrashedProjectScreen renders on the next refresh.
  useProjectTombstoneObserver(doc, project?.id ?? null, refresh)

  // Drives the editor-area rendering: loading skeleton vs. empty state vs.
  // EditorTable. Centralizes the decision so we don't flash between states
  // while a file hydrates.
  const cellAreaState = useMemo(
    () => deriveCellAreaState({
      activeFileId,
      docLoading,
      hasDoc: Boolean(doc),
      cellCount: cells.length,
      syncStatus: fileSyncStatus,
    }),
    [activeFileId, docLoading, doc, cells.length, fileSyncStatus]
  )

  // Project-wide presence room: everyone in the project joins regardless of
  // which file they're viewing, so the toolbar can show peers who are online
  // even when they're on different files.
  const presenceDoc = useMemo(() => (activeShareToken ? new Y.Doc() : null), [activeShareToken])
  const presenceRoom = activeShareToken ? `codex:share:${activeShareToken}:presence` : null
  const { peers: presencePeers } = useSync({
    doc: presenceDoc,
    roomName: presenceRoom,
    username: currentUsername,
    currentFileId: activeFileId || undefined,
    enabled: Boolean(presenceRoom),
  })

  // Merge file-level peers (who are in the same file as us) with project-wide
  // presence peers, deduping by peerId. File-level entries take precedence for
  // richer awareness like cursor state.
  const peers = useMemo(() => {
    const byId = new Map<string, (typeof presencePeers)[number]>()
    for (const p of presencePeers) byId.set(p.peerId, p)
    for (const p of fileLevelPeers) byId.set(p.peerId, p)
    return Array.from(byId.values())
  }, [fileLevelPeers, presencePeers])

  const collabUser = useMemo(() => {
    if (!syncProvider) return undefined
    const clientId = String(syncProvider.awareness.clientID)
    return {
      name: displayNameFor(currentUsername, clientId),
      color: peerColorLocal(clientId),
    }
  }, [syncProvider, currentUsername])

  async function handleSearchSelect(result: WorkspaceSearchResult) {
    if (result.fileId !== activeFileId) {
      workspaceTabs.openFile(result.fileId)
      setTimeout(() => {
        const idx = cells.findIndex((c) => c.id === result.cellId)
        if (idx >= 0) editorRef.current?.scrollToCellIndex(idx)
      }, 400)
    } else {
      const idx = cells.findIndex((c) => c.id === result.cellId)
      if (idx >= 0) editorRef.current?.scrollToCellIndex(idx)
    }
  }

  const perms = useProjectPermissions(project)
  const isReadOnly = !perms.canEditContent

  const { sync: runSync, phase: syncPhase, inFlight: syncInFlight, lastResult: syncLastResult } = useSyncProject()

  useAutoSync(project ?? null, frontierSession)
  useCorpusBackfill(project ?? null, refresh)

  const { state: checklistState, dismissed: checklistDismissed, dismiss: dismissChecklist, refreshShares: refreshChecklistShares } = useSetupChecklist(project ?? null)
  const [checklistOpen, setChecklistOpen] = useState(!checklistDismissed)
  const livingMemoryEnabled = useFeatureFlag("living-memory-view", project)

  useEffect(() => {
    if (!checklistDismissed) setChecklistOpen(true)
  }, [checklistDismissed])

  const handleProjectUpdated = useCallback(async (_updated: ProjectRecord | undefined) => {
    // The caller (useSaveCompletionSettings, SyncButton, etc.) already
    // persisted to IDB. We just need to refresh the in-memory project state.
    refresh()
  }, [refresh])

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (!project || !perms.canPush || !frontierSession) return
        e.preventDefault()
        if (syncInFlight) return
        runSync(project, frontierSession).then((r) => {
          if (r?.status === "synced" && r.commitSha && project.origin?.kind === "git") {
            const commitSha = r.commitSha
            patchProject(project.id, (p) => ({
              ...p,
              origin: { ...p.origin!, headSha: commitSha },
            })).then(() => refresh())
          }
        })
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [project, perms.canPush, frontierSession, syncInFlight, runSync, handleProjectUpdated])

  // All hooks below must live above the early return so hook count is stable
  // across renders (React throws "Rendered more hooks" otherwise).

  const suggestions = useMemo(
    () => (project ? detectSuggestions(project) : []),
    [project]
  )
  const bannerSuggestions = useMemo(() => {
    if (!project || project.suggestionsDismissedAt) return []
    return suggestions
  }, [project, suggestions])
  const suggestionFileIds = useMemo(
    () => new Set(suggestions.map((s) => s.fileId)),
    [suggestions]
  )

  const [moveTargetId, setMoveTargetId] = useState<string | null>(null)
  const [moveCorpus, setMoveCorpus] = useState("")
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ project: ProjectRecord } | null>(null)

  const handleRename = useCallback(async (fileId: string, newName: string) => {
    if (!project) return
    try {
      await patchProject(project.id, (p) => renameFile(p, fileId, newName))
      refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : "Rename failed")
    }
  }, [project, refresh])

  const handleDeleteFile = useCallback(async (fileId: string) => {
    if (!project) return
    await patchProject(project.id, (p) => deleteFile(p, fileId))
    refresh()
    if (activeFileId === fileId) setActiveFileId(null)
    // Tell frontier-server to drop the projection rows for this file too.
    // Best-effort: a failure here doesn't roll back the local delete — the
    // D1 row just becomes an orphan until a future sweep.
    void deleteFileProjection({
      jwt: frontierSession?.jwt ?? null,
      projectId: project.id,
      fileId,
    })
  }, [project, refresh, activeFileId, setActiveFileId, frontierSession])

  const handleApplySuggestions = useCallback(async (chosen: RenameSuggestion[]) => {
    if (!project) return
    const before = await getProject(project.id)
    await patchProject(project.id, (p) => applySuggestions(p, chosen))
    refresh()
    if (before) setUndo({ project: before })
    setTimeout(() => setUndo((u) => (u?.project === before ? null : u)), 10000)
  }, [project, refresh])

  const handleDismissBanner = useCallback(async () => {
    if (!project) return
    await patchProject(project.id, (p) => ({ ...p, suggestionsDismissedAt: new Date().toISOString() }))
    refresh()
  }, [project, refresh])

  const projectNavItems = useMemo(() => {
    const items = [
      { id: "rules", label: "Rules", icon: Scale,
        onClick: () => navigate(`/project/${projectId}/rules`) },
      { id: "comments", label: "Comments", icon: MessagesSquare,
        badge: Array.from(openCommentCount.values()).reduce((a, b) => a + b, 0),
        onClick: () => navigate(`/project/${projectId}/comments`) },
      { id: "snapshots", label: "Snapshots", icon: Camera,
        onClick: () => navigate(`/project/${projectId}/snapshots`) },
      { id: "share", label: "Share", icon: Share2,
        onClick: () => setShareOpen(true) },
      { id: "settings", label: "Settings", icon: SettingsIcon,
        onClick: () => navigate(`/project/${projectId}/settings`) },
    ]
    if (livingMemoryEnabled) {
      // Insert before Share so it sits with Rules/Comments/Snapshots.
      const insertIdx = items.findIndex((i) => i.id === "share")
      items.splice(insertIdx, 0, {
        id: "living-memory",
        label: "Living Memory",
        icon: Brain,
        onClick: () => navigate(`/project/${projectId}/memory`),
      })
    }
    return items
  }, [projectId, navigate, openCommentCount, livingMemoryEnabled])

  const actionCtx = useMemo(() => ({
    project: project!,
    activeFileId,
    fileProgress,
  }), [project, activeFileId, fileProgress])

  async function handleExport() {
    if (!activeFileId) return
    try {
      const { blob, filename } = await exportFile(activeFileId)
      downloadBlob(blob, filename)
    } catch (err) {
      alert(`Export failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }

  const actionArgs = useMemo(() => ({
    openImport: () => setImportOpen(true),
    runCompletions: () => { if (activeFileId) completeBatch(cells) },
    runExport: () => handleExport(),
    runBatchValidate: () => {
      console.info("batch-validate triggered (placeholder runner)")
    },
    runAgentInput: () => {
      console.info("agent-input triggered (placeholder runner)")
    },
    runImportWip: () => setImportOpen(true),
    navigate,
  }), [activeFileId, completeBatch, cells, navigate])

  if (status === "loading") return <div className="p-8 text-muted-foreground">Loading...</div>
  if (status === "no-session") {
    return (
      <div className="p-8 text-muted-foreground">
        This project isn't on this device. <button className="underline" onClick={() => navigate("/")}>Sign in</button> to open it from the cloud.
      </div>
    )
  }
  if (status === "not-found" || !project) {
    return (
      <div className="p-8 text-muted-foreground">
        Project not found, or you don't have access. <button className="underline" onClick={() => navigate("/")}>Back to dashboard</button>.
      </div>
    )
  }

  if (project.deletedAt) {
    return (
      <TrashedProjectScreen
        project={project}
        onClose={() => navigate("/")}
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

  async function handleImported(refs: FileReference[]) {
    if (!project) return
    await patchProject(project.id, (p) => ({ ...p, files: [...p.files, ...refs] }))
    refresh()
    if (refs.length > 0) workspaceTabs.openFile(refs[0].id)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <EditorScrollProvider>
      {/* ScrollToGroupHandler must live inside EditorScrollProvider so it can call useEditorScroll */}
      <ScrollToGroupHandler cells={cells} editorRef={editorRef} />
      <AppShell
        sidebar={
          <>
            <div className="border-b p-2">
              <AccountSwitcher />
            </div>
            <SuggestionBanner
              suggestions={bannerSuggestions}
              onApply={handleApplySuggestions}
              onDismiss={handleDismissBanner}
            />
            <ExpandableFileList
              projectId={projectId!}
              files={project.files}
              activeFileId={activeFileId}
              fileProgress={fileProgress}
              suggestionFileIds={suggestionFileIds}
              validationCount={validationCount}
              onSelectFile={workspaceTabs.openFile}
              onRename={handleRename}
              onMove={(fileId) => {
                setMoveTargetId(fileId)
                setMoveCorpus(project.files.find((f) => f.id === fileId)?.corpusMarker ?? "")
              }}
              onDelete={(fileId) => setPendingDeleteId(fileId)}
            />
            <SidebarProjectSection items={projectNavItems} />
            <SidebarCommandPaletteHint onClick={() => setSearchOpen(true)} />
          </>
        }
        header={
          <WorkspaceHeader project={project} onBack={() => navigate("/")}>
            <ViewSettingsMenu
              fileOpen={Boolean(activeFileId)}
              lineNumbersEnabled={fileMeta.lineNumbersEnabled}
              sourceTextDirection={fileMeta.sourceTextDirection}
              targetTextDirection={fileMeta.targetTextDirection}
              cellLabelsEnabled={cellLabelsEnabled}
              rtlHintDismissed={fileMeta.rtlHintDismissed}
              onLineNumbersChange={fileMeta.setLineNumbersEnabled}
              onSourceTextDirectionChange={fileMeta.setSourceTextDirection}
              onTargetTextDirectionChange={fileMeta.setTargetTextDirection}
              onCellLabelsChange={setCellLabelsEnabled}
              onDismissRtlHint={fileMeta.dismissRtlHint}
            />
            {isSubtitleFile && (
              <button
                className="rounded p-1.5 hover:bg-accent"
                onClick={() => setVideoDialogOpen(true)}
                title="Attach video"
              >
                <Film className="h-4 w-4" />
              </button>
            )}
            {!checklistDismissed && checklistState.totalCount > 0 && checklistState.completedCount < checklistState.totalCount && (
              <button
                onClick={() => setChecklistOpen(true)}
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent"
                title="Open setup checklist"
              >
                <ClipboardList className="h-3 w-3" />
                Setup: {checklistState.completedCount}/{checklistState.totalCount}
              </button>
            )}
            <NextUnfinishedButton
              onClick={handleJumpNextUnfinished}
              disabled={!activeFileId || !hasUnfinished}
            />
            <PrimaryActionButton ctx={actionCtx} run={actionArgs} />
          </WorkspaceHeader>
        }
        beforeMain={
          <>
            <TabStrip
              tabs={workspaceTabs.tabs}
              activeTabId={workspaceTabs.activeTabId}
              files={projectFiles}
              onActivate={workspaceTabs.activateTab}
              onClose={workspaceTabs.closeTab}
            />
            {isReadOnly && (
              <div className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-900">
                <Lock className="h-3.5 w-3.5" />
                Read-only — imported from git. Push is coming in Phase 2.
              </div>
            )}
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
          </>
        }
        main={cellAreaState.kind === "ready" && doc ? (
          <EditorTable
            ref={editorRef} project={project} cells={cells} doc={doc}
            username={currentUsername}
            isCompletionConfigured={isConfigured} isCompletionAvailable={isCompletionAvailable} completing={completing}
            examples={examples} errors={errors}
            onCompleteSingle={completeSingle} onCompleteBatch={completeBatch}
            healthMap={healthMap} infractions={infractions} rules={rules}
            onInfractionClick={(ruleId) => {
              setCommentsCellId(null); setHistoryCellId(null); setDrawerRuleId(ruleId)
            }}
            isBacktranslationConfigured={isBacktranslationConfigured}
            onBacktranslate={runBacktranslation}
            backtranslating={backtranslating}
            backtranslationErrors={backtranslationErrors}
            cellOpenCommentCount={cellOpenCommentCount}
            onOpenComments={(cellId) => {
              setDrawerRuleId(null); setHistoryCellId(null); setCommentsCellId(cellId)
            }}
            onOpenHistory={(cellId) => {
              setDrawerRuleId(null); setCommentsCellId(null); setHistoryCellId(cellId)
            }}
            syncProvider={syncProvider} collabUser={collabUser}
            activeCueIndex={activeCueIndex >= 0 ? activeCueIndex : undefined}
            onSeekToCue={isSubtitleFile ? handleCueSeek : undefined}
            lineNumbersEnabled={fileMeta.lineNumbersEnabled}
            cellLabelsEnabled={cellLabelsEnabled}
            sourceTextDirection={fileMeta.sourceTextDirection}
            targetTextDirection={fileMeta.targetTextDirection}
            isAnonymous={!frontierSession}
            breakdownMap={health.breakdownMap}
            onJumpToCell={jumpToCellId}
            onAiSetupNeeded={() => setAiSetupOpen(true)}
            onOpenRecording={(cellId) => setRecordingCellId(cellId)}
          />
        ) : (
          <CellAreaPlaceholder
            state={cellAreaState}
            fileName={activeFile?.name}
            onImportClick={() => setImportOpen(true)}
          />
        )}
        aside={
          <>
            {drawerRuleId && (
              <RuleDrawer
                rule={drawerRule}
                infractions={drawerInfractions}
                cells={cells}
                onClose={() => setDrawerRuleId(null)}
                onNavigateToCell={() => {}}
                project={project}
                doc={doc}
                username={currentUsername}
                refresh={refresh}
                cellsByFile={fileCells}
              />
            )}
            {commentsCell && (
              <CommentsDrawer
                project={project} cell={commentsCell}
                onClose={() => setCommentsCellId(null)}
                onNewThread={(text) => addThread(commentsCell.id, text)}
                onReply={(threadId, text) => addMessage(commentsCell.id, threadId, text)}
                onResolve={(threadId, msg) => resolveThread(commentsCell.id, threadId, msg)}
                onReopen={(threadId) => reopenThread(commentsCell.id, threadId)}
              />
            )}
            {historyCell && (
              <HistoryDrawer cell={historyCell} onClose={() => setHistoryCellId(null)} />
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
                </div>
              }
              right={
                <SyncButton
                  project={project}
                  onUpdated={handleProjectUpdated}
                  sync={runSync}
                  phase={syncPhase}
                  inFlight={syncInFlight}
                  lastResult={syncLastResult}
                />
              }
            />
            <StatusBar
              cells={cells}
              projectHealth={projectHealth}
              projectBreakdown={projectBreakdown}
              biggestDrags={biggestDrags}
              onJumpToCell={jumpToCellId}
            />
          </>
        }
      />
      {project && (
        <SetupChecklistDrawer
          open={checklistOpen && !checklistDismissed}
          onOpenChange={setChecklistOpen}
          project={project}
          state={checklistState}
          onDismiss={() => { dismissChecklist(); setChecklistOpen(false) }}
          onProjectUpdated={handleProjectUpdated}
          onSharesChanged={refreshChecklistShares}
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
      {project && doc && (
        <AudioRecordingModal
          open={recordingCellId !== null}
          project={project}
          doc={doc}
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
      <ImportDialog open={importOpen} onOpenChange={setImportOpen}
        sourceLanguage={project.sourceLanguage} targetLanguage={project.targetLanguage}
        onImported={handleImported} />
      <SearchDialog
        open={searchOpen} onOpenChange={setSearchOpen}
        onReady={buildIndex} loading={searchLoading} ready={searchReady}
        results={searchResults} onSearch={runSearch} onSelect={handleSearchSelect}
      />
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
        onSelect={handleSearchSelect}
        username={currentUsername}
        isReadOnly={isReadOnly}
        onAfterReplace={rebuildSearchIndex}
      />
      <SharePanel
        open={shareOpen} onOpenChange={setShareOpen}
        projectId={projectId!}
        username={project.username || "anonymous"}
        onSharesChanged={() => setShareRefreshKey((k) => k + 1)}
      />
      <VideoAttachmentDialog
        open={videoDialogOpen} onOpenChange={setVideoDialogOpen}
        current={videoAttachment} onSave={saveVideo}
      />
      <ConfirmActionDialog
        open={pendingDeleteId !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteId(null) }}
        title="Delete file"
        description={(() => {
          const f = pendingDeleteId ? project.files.find((x) => x.id === pendingDeleteId) : null
          return f ? `Remove "${f.name}" from this project? The underlying data is not deleted from disk.` : ""
        })()}
        confirmLabel="Delete"
        checkboxLabel="I understand this removes the file from the project."
        onConfirm={() => { if (pendingDeleteId) handleDeleteFile(pendingDeleteId); setPendingDeleteId(null) }}
      />
      <Dialog open={moveTargetId !== null} onOpenChange={(v) => { if (!v) setMoveTargetId(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Move to corpus</DialogTitle></DialogHeader>
          <input
            value={moveCorpus}
            onChange={(e) => setMoveCorpus(e.target.value)}
            placeholder="Corpus name (or blank to ungroup)"
            className="w-full rounded border px-2 py-1"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveTargetId(null)}>Cancel</Button>
            <Button onClick={async () => {
              if (!project || !moveTargetId) return
              await patchProject(project.id, (p) => moveFileToCorpus(p, moveTargetId, moveCorpus))
              refresh()
              setMoveTargetId(null)
            }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {undo && (
        <div className="fixed bottom-4 right-4 z-[70] flex items-center gap-2 rounded border bg-background px-3 py-2 text-sm shadow-md">
          <span>Applied renames.</span>
          <Button size="sm" variant="outline" onClick={async () => {
            if (!undo) return
            await updateProject(undo.project)
            refresh()
            setUndo(null)
          }}>Undo</Button>
        </div>
      )}
    </EditorScrollProvider>
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
    const { group: groupId, section: sectionLabel } = editorScroll.consume()
    if (!groupId && !sectionLabel) return

    let idx = -1
    if (sectionLabel) {
      // Match by section label first (e.g. "GEN 1")
      idx = cells.findIndex((c) => c.section === sectionLabel)
      // Fallback: match by group
      if (idx < 0) idx = cells.findIndex((c) => (c.group ?? "Ungrouped") === sectionLabel)
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
      <div className="max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
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
