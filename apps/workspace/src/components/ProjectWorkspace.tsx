import { Suspense, lazy, useState, useMemo, useRef, useEffect, useCallback } from "react"
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router-dom"
import { useProject } from "@/hooks/useProject"
import { deriveCellAreaState } from "@/lib/editor/cell-area-state"
import { CellAreaPlaceholder } from "./CellAreaPlaceholder"
import { TabStrip } from "./TabStrip"
import { useWorkspaceTabs, readLastActiveFileId } from "@/hooks/useWorkspaceTabs"
import { useCells } from "@/hooks/useCells"
import { useStaleSourceCells } from "@/hooks/useStaleSourceCells"
import { useSearchIndex } from "@/hooks/useSearchIndex"
import { useCompletion } from "@/hooks/useCompletion"
import { fetchBranchingSearch } from "@/lib/sync/branching-search-read"
import { fetchBranchingSearchPassages } from "@/lib/sync/branching-search-passages-read"
import type { ScoredPair } from "@/lib/search/dual-index"
import type { PassageHit } from "@/hooks/useSearchIndex"
import { useHealth } from "@/hooks/useHealth"
import { useRules } from "@/hooks/useRules"
import { updateProject, patchProject, getProject } from "@/lib/store/project-index"
import { MAX_BATCH_COMPLETIONS } from "@/lib/workspace-actions/registry"
import type { FileReference, CellHealthBreakdown } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { useWorkspaceSearch } from "@/hooks/useWorkspaceSearch"
import { ParallelPassagesPanel, type ParallelPanelMode, type ParallelPanelScope } from "./ParallelPassagesPanel"
import type { EditorTableHandle } from "./EditorTable"
import type { WorkspaceSearchResult } from "@/hooks/useWorkspaceSearch"
import { StatusBar } from "./StatusBar"
import { SyncStatusIndicator } from "./SyncStatusIndicator"
import { OutboxSyncIndicator } from "./OutboxSyncIndicator"
import { EditorTable } from "./EditorTable"
import { AudioRecordingModal } from "./AudioRecorder/AudioRecordingModal"
import { RuleDrawer } from "./RuleDrawer"
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
import { useOutboxFlusher } from "@/hooks/useOutboxFlusher"
import { usePendingOutboxRecords } from "@/hooks/usePendingOutboxRecords"
import {
  setCqrsOutboxBridge,
  buildFileScopedTokenFetcher,
} from "@/lib/sync/cqrs-bridge"
import { emitTargetCellCommit } from "@/lib/sync/events-emit"
import { flushOutboxBatch } from "@/lib/sync/outbox-flush"
import { useCellsAuditStatsWithOverlay } from "@/hooks/useCellsAuditStatsWithOverlay"
import { Film, Scale, MessagesSquare, Camera, Share2, Settings as SettingsIcon, Lock, ClipboardList, Brain, Trash2, Undo2, Search as SearchIcon, Sparkles } from "lucide-react"
import { restoreProject } from "@/lib/store/project-index"
import { AppShell } from "./AppShell"
import { WorkspaceHeader } from "./WorkspaceHeader"
import { VoiceBar } from "./VoiceBar"
import { SpeakBarToggle } from "./SpeakBarToggle"
import { setSpeakBarEnabled, useSpeakBarEnabled } from "@/lib/audio/speak-bar-pref"
import { SelectionBar } from "./SelectionBar"
import { WorkspaceStatusBar } from "./WorkspaceStatusBar"
import { PrimaryActionButton } from "./PrimaryActionButton"
import { AccountSwitcher } from "./AccountSwitcher"
import { ExpandableFileList } from "./ExpandableFileList"
import { SidebarProjectSection } from "./SidebarProjectSection"
import { SuggestionBanner } from "./SuggestionBanner"
import { ConfirmActionDialog } from "./ConfirmActionDialog"
import { PeerPresence } from "./PeerPresence"
import { ViewSettingsMenu } from "./ViewSettingsMenu"
import { EditorScrollProvider, useEditorScroll } from "@/context/EditorScrollContext"
import { detectSuggestions, type RenameSuggestion } from "@/lib/file-labeling/detect"
import { applySuggestions } from "@/lib/file-labeling/apply"
import { renameFile, moveFileToCorpus, renameCorpus, deleteFile } from "@/lib/store/file-operations"
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
import { SystemPromptNudge } from "./onboarding/SystemPromptNudge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useFeatureFlag } from "@/hooks/useFeatureFlag"
import { NextUnfinishedButton } from "./NextUnfinishedButton"
import { useNextUnfinished } from "@/hooks/useNextUnfinished"
import { AiSetupDialog } from "./AiSetupDialog"
import {
  buildExportHandoffUrl,
  buildProjectSettingsHandoffUrl,
  workspaceReturnPath,
} from "@/lib/ad11/navigation"

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

export function ProjectWorkspace() {
  const { id: projectId, fileId: routeFileId } = useParams<{ id: string; fileId?: string }>()
  const navigate = useNavigate()
  const goToProjects = useCallback(() => {
    window.location.assign("/projects/")
  }, [])
  const { project: loadedProject, status, refresh } = useProject(projectId!)

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
  useEffect(() => {
    optimisticFileIdsRef.current = new Set()
    setOptimisticFiles([])
  }, [projectId])

  const projectFiles = useMemo(() => {
    const serverFiles = loadedProject?.files ?? []
    if (optimisticFiles.length === 0) return serverFiles

    const seen = new Set(serverFiles.map((file) => file.id))
    const pending = optimisticFiles.filter((file) => !seen.has(file.id))
    return pending.length > 0 ? [...serverFiles, ...pending] : serverFiles
  }, [loadedProject?.files, optimisticFiles])

  const project = useMemo<ProjectRecord | null>(() => {
    if (!loadedProject) return null
    if (projectFiles === loadedProject.files) return loadedProject
    return { ...loadedProject, files: projectFiles }
  }, [loadedProject, projectFiles])

  useEffect(() => {
    if (!loadedProject || optimisticFiles.length === 0) return
    const serverIds = new Set(loadedProject.files.map((file) => file.id))
    setOptimisticFiles((current) => {
      const next = current.filter((file) => !serverIds.has(file.id))
      optimisticFileIdsRef.current = new Set(next.map((file) => file.id))
      return next
    })
  }, [loadedProject, optimisticFiles.length])

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

  // Single source of truth for the fileId in the URL. This used to be two
  // separate effects — one that *restored* a file when the URL had none
  // (after a detour through Rules/Comments/Snapshots), and one further down
  // that *stripped* a fileId the project didn't recognize. They fought:
  // restore → strip → restore → …, each hop a `navigate({replace:true})` =
  // a `history.replaceState`. The browser caps that at 100/10s and throws
  // SecurityError, and the re-render storm also tore the project WebSocket
  // down before it could connect. Merging them — and only navigating when
  // the destination differs from the current path — makes the redirect
  // converge in one hop. Reads localStorage directly because it only needs
  // to fire on the no-fileId render.
  const location = useLocation()
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

    // No file in the URL: restore the last/only file if there is a valid one.
    const last = readLastActiveFileId(projectId)
    const firstOpenTab = workspaceTabs.tabs[0]?.fileId ?? null
    const onlyFile = projectFiles.length === 1 ? projectFiles[0]?.id : null
    const nextFileId =
      last && fileIds.includes(last)
        ? last
        : firstOpenTab && fileIds.includes(firstOpenTab)
          ? firstOpenTab
          : onlyFile
    if (!nextFileId) return
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
  const [drawerRuleId, setDrawerRuleId] = useState<string | null>(null)
  const [searchParams] = useSearchParams()
  useEffect(() => {
    const open = searchParams.get("openRule")
    if (open) setDrawerRuleId(open)
  }, [searchParams])
  const [commentsCellId, setCommentsCellId] = useState<string | null>(null)
  const [historyCellId, setHistoryCellId] = useState<string | null>(null)
  const [parallelOpen, setParallelOpen] = useState(false)
  const [parallelMode, setParallelMode] = useState<ParallelPanelMode>("search")
  const [parallelScope, setParallelScope] = useState<ParallelPanelScope>("project")
  const [shareOpen, setShareOpen] = useState(false)
  const [aiSetupOpen, setAiSetupOpen] = useState(false)
  const [recordingCellId, setRecordingCellId] = useState<string | null>(null)
  const editorRef = useRef<EditorTableHandle>(null)
  const speakBarEnabled = useSpeakBarEnabled(project?.id)
  // Phase 2c-gamma: the per-file Y.Doc is gone. The editor hydrates from the
  // cells projection and writes via the outbox. `doc`/`docLoading` are
  // retained as no-op constants so downstream cellAreaState + props don't
  // need a wider refactor.
  const doc: null = null
  // Prefer the Frontier session username (authenticated identity) over the
  // project-level username setting. Validation entries and edit history
  // should attribute to the actual signed-in user.
  const { session: frontierSession } = useFrontierSession()
  const currentUsername = frontierSession?.username || project?.username || "local"
  const jwtRef = useRef<string | null>(null)
  useEffect(() => {
    jwtRef.current = frontierSession?.jwt ?? null
  }, [frontierSession?.jwt])

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
      },
    )
  }, [
    project?.id,
    project?.name,
    project?.origin?.kind,
    project?.origin?.kind === "git" ? project?.origin.gitlabProjectId : undefined,
  ])

  useEffect(() => {
    if (!project?.id || !activeFileId) {
      setCqrsOutboxBridge(null)
      return
    }
    setCqrsOutboxBridge({
      projectId: project.id,
      activeFileId,
      username: currentUsername,
    })
    return () => setCqrsOutboxBridge(null)
  }, [project?.id, activeFileId, currentUsername])

  const outboxFlushEnabled = Boolean(project?.id && frontierSession?.jwt)
  const {
    pendingCount: outboxPending,
    failureStreak: outboxFailures,
    refreshPending: refreshOutboxPending,
  } = useOutboxFlusher({
    enabled: outboxFlushEnabled,
    getTokenForFile,
  })
  const outboxRecords = usePendingOutboxRecords({
    enabled: Boolean(project?.id),
    fileId: null,
  })

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
  const { cells, revalidate: revalidateCells } = useCells({
    projectId: project?.id ?? null,
    fileId: activeFileId,
    username: currentUsername,
    requiredValidations: validationCount,
    auditStats: auditStatsByCellId,
    getToken: getTokenForFile,
    enabled: Boolean(project?.id && activeFileId && frontierSession?.jwt),
  })
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
  const { hasAny: hasUnfinished, findNext: findNextUnfinished } = useNextUnfinished(cells, validationCount)
  const handleJumpNextUnfinished = useCallback(() => {
    const currentIndex = editorRef.current?.getCurrentIndex?.() ?? 0
    const next = findNextUnfinished(currentIndex)
    if (next >= 0) editorRef.current?.scrollToCellIndex(next)
  }, [findNextUnfinished])
  const fileMeta = useFileMeta(activeFileId, project?.sourceLanguage, project?.targetLanguage)
  const [cellLabelsEnabled, setCellLabelsEnabled] = useCellLabelsPreference(projectId!)

  const activeFile = activeFileId ? project?.files.find((f) => f.id === activeFileId) : null
  const isSubtitleFile = activeFile?.type === "vtt" || activeFile?.type === "srt"

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
    clear: clearSearchResults,
    results: searchResults,
    loading: searchLoading,
    ready: searchReady,
  } = useWorkspaceSearch(project?.files || [])

  // Captures the latest cells in a ref so post-navigation flash can read them
  // without racing React re-renders.
  const cellsRef = useRef(cells)
  useEffect(() => { cellsRef.current = cells }, [cells])

  const { rules, penalties } = useRules(project ?? null, refresh)
  // Phase 2c-gamma: comments lived on Y.Doc maps; the v1.x event grammar
  // for threads/messages isn't in this build. No-op handlers so the comments
  // drawer renders empty rather than the workspace crashing.
  const addThread: (..._: unknown[]) => void = () => {}
  const addMessage: (..._: unknown[]) => void = () => {}
  const resolveThread: (..._: unknown[]) => void = () => {}
  const reopenThread: (..._: unknown[]) => void = () => {}
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
    await emitTargetCellCommit({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      parentId: cell.targetEventId ?? cell.sourceEventId ?? null,
      sourceEventId: cell.sourceEventId ?? null,
      value: text,
      author,
    })
    await flushOutboxBatch({ getTokenForFile })
    await refreshOutboxPending()
    revalidateAuditStats()
    revalidateCells()
  }, [project?.id, getTokenForFile, refreshOutboxPending, revalidateAuditStats, revalidateCells])
  const { completeSingle, completeBatch, isConfigured, isAvailable: isCompletionAvailable, completing, examples, errors } = useCompletion(
    project?.completionSettings, project?.sourceLanguage || "", project?.targetLanguage || "", branchingSearch, branchingSearchPassages, frontierSession, commitCompletedCell
  )

  // Phase 2c-gamma: backtranslation wrote through Y.Doc; the writeback hookup
  // is deferred to v1.x. The button still renders disabled.
  const runBacktranslation: (..._: unknown[]) => Promise<void> = async () => {}
  const backtranslating: Set<string> = new Set()
  const backtranslationErrors: Map<string, string> = new Map()
  const isBacktranslationConfigured = false

  const compositeFlag = useFeatureFlag("composite-health", project ?? null)
  const healthConfig = useMemo(() => resolveHealthConfig(project ?? null), [project])
  const requiredValidations = project ? readValidationCount(project) : 1

  const health = useHealth(
    fileCells,
    project?.completionSettings?.llmHealthPenalty ?? 0.1,
    rules,
    penalties,
    { composite: compositeFlag, compositeConfig: healthConfig, requiredValidations, auditStats: auditStatsByCellId },
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
  const [cellsWithRemoteChange, setCellsWithRemoteChange] = useState<Set<string>>(() => new Set())
  const focusedCellIdRef = useRef<string | null>(null)
  const reconcilerRef = useRef<import("@/lib/sync/ws-reconciler").WsReconciler | null>(null)
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
              if (!msg.cell || msg.project !== pid) return
              revalidateCells()
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
              const next = new Map<string, string>()
              for (const u of msg.users) {
                if (!u.focusedCell) continue
                if (u.userId === currentUsername) continue
                next.set(u.focusedCell, u.userId)
              }
              setCellLockHolders(next)
            } else if (msg.t === "lock.claimed") {
              if (msg.by.userId === currentUsername) return
              setCellLockHolders((cur) => {
                if (cur.get(msg.cellId) === msg.by.userId) return cur
                const next = new Map(cur)
                next.set(msg.cellId, msg.by.userId)
                return next
              })
            } else if (msg.t === "lock.released") {
              setCellLockHolders((cur) => {
                if (!cur.has(msg.cellId)) return cur
                const next = new Map(cur)
                next.delete(msg.cellId)
                return next
              })
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
    })()
    return () => {
      cancelled = true
      reconcilerRef.current = null
      reconciler?.close()
    }
  }, [project?.id, frontierSession?.jwt, getTokenForFile, revalidateCells, currentUsername, refresh])

  const handleClaimCell = useCallback((cellId: string) => {
    focusedCellIdRef.current = cellId
    reconcilerRef.current?.send({ t: "focus.claim", cellId })
  }, [])
  const handleReleaseCell = useCallback((cellId: string) => {
    if (focusedCellIdRef.current === cellId) focusedCellIdRef.current = null
    reconcilerRef.current?.send({ t: "focus.release", cellId })
  }, [])
  const handleAckRemoteChange = useCallback((cellId: string) => {
    setCellsWithRemoteChange((cur) => {
      if (!cur.has(cellId)) return cur
      const next = new Set(cur)
      next.delete(cellId)
      return next
    })
  }, [])

  // Drives the editor-area rendering: loading skeleton vs. empty state vs.
  // EditorTable. Centralizes the decision so we don't flash between states
  // while a file hydrates.
  const cellAreaState = useMemo(
    () => deriveCellAreaState({
      activeFileId,
      cellCount: cells.length,
      syncStatus: fileSyncStatus,
    }),
    [activeFileId, cells.length, fileSyncStatus]
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

  const { state: checklistState, dismissed: checklistDismissed, dismiss: dismissChecklist, refreshShares: refreshChecklistShares } = useSetupChecklist(project ?? null)
  const [checklistOpen, setChecklistOpen] = useState(false)
  const [showChipTooltip, setShowChipTooltip] = useState(false)
  const livingMemoryEnabled = useFeatureFlag("living-memory-view", project)

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

  const handleProjectUpdated = useCallback(async (_updated: ProjectRecord | undefined) => {
    // The caller (useSaveCompletionSettings, etc.) already persisted to IDB.
    // We just need to refresh the in-memory project state.
    refresh()
  }, [refresh])

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
  const existingCorpusMarkers = useMemo(() => {
    const set = new Set<string>()
    for (const f of project?.files ?? []) {
      const m = f.corpusMarker?.trim()
      if (m) set.add(m)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [project?.files])
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
    // Tell identity to drop the projection rows for this file too.
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
    const dismissedAt = new Date().toISOString()
    // Apply the user's choices and dismiss the banner in the same write:
    // once they've engaged, the banner is no longer useful and shouldn't
    // re-appear for any remaining (unchosen) suggestions until they
    // explicitly re-run detection from the overflow menu.
    await patchProject(project.id, (p) => ({
      ...applySuggestions(p, chosen),
      suggestionsDismissedAt: dismissedAt,
    }))
    refresh()
    if (before) setUndo({ project: before })
    setTimeout(() => setUndo((u) => (u?.project === before ? null : u)), 10000)
  }, [project, refresh])

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
    if (!project) return
    await patchProject(project.id, (p) => ({ ...p, suggestionsDismissedAt: new Date().toISOString() }))
    refresh()
  }, [project, refresh])

  const handleReinviteSuggestions = useCallback(async () => {
    if (!project) return
    await patchProject(project.id, (p) => {
      const next = { ...p }
      delete next.suggestionsDismissedAt
      return next
    })
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
        onClick: () => {
          if (!projectId) return
          window.location.assign(buildProjectSettingsHandoffUrl({
            projectId,
            returnTo: workspaceReturnPath(projectId, activeFileId),
          }))
        } },
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
  }, [projectId, activeFileId, navigate, openCommentCount, livingMemoryEnabled])

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
    audioCounts,
  }), [project, activeFileId, fileProgress, audioCounts])

  const openImportFlow = useCallback(() => {
    if (!project) return
    setImportOpen(true)
  }, [project])

  const openExportFlow = useCallback(() => {
    if (!project) return
    window.location.assign(buildExportHandoffUrl({
      projectId: project.id,
      fileId: activeFileId,
      returnTo: workspaceReturnPath(project.id, activeFileId),
    }))
  }, [project, activeFileId])

  const actionArgs = useMemo(() => ({
    openImport: openImportFlow,
    runCompletions: () => {
      if (!activeFileId) return
      const untranslated = cells.filter((c) => !c.translated.trim())
      if (untranslated.length === 0) return
      completeBatch(untranslated.slice(0, MAX_BATCH_COMPLETIONS))
    },
    runExport: openExportFlow,
    runBatchValidate: () => {
      console.info("batch-validate triggered (placeholder runner)")
    },
    runAgentInput: () => {
      console.info("agent-input triggered (placeholder runner)")
    },
    runImportWip: openImportFlow,
    // Phase 2c-gamma: bulk transcribe/synth wrote attachments to Y.Doc; the
    // writeback grammar lands in v1.x. Stubbed so the workspace actions menu
    // still renders without crashing.
    runTranscribeAll: () => {
      console.warn("[ProjectWorkspace] transcribe-all disabled in Phase 2c-gamma")
    },
    runSynthAll: () => {
      console.warn("[ProjectWorkspace] synth-all disabled in Phase 2c-gamma")
    },
    navigate,
  }), [activeFileId, completeBatch, cells, project, frontierSession, navigate, openImportFlow, openExportFlow])

  const handleCellCommitted = useCallback(async () => {
    await flushOutboxBatch({ getTokenForFile })
    await refreshOutboxPending()
    revalidateAuditStats()
    revalidateCells()
  }, [getTokenForFile, refreshOutboxPending, revalidateAuditStats, revalidateCells])

  if (status === "loading") return <div className="p-8 text-muted-foreground">Loading...</div>
  if (status === "no-session") {
    return (
      <div className="p-8 text-muted-foreground">
        This project isn't on this device. <button className="underline" onClick={goToProjects}>Sign in</button> to open it from the cloud.
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

  async function handleImported(refs: FileReference[]) {
    if (!project) return
    const localProject = await getProject(project.id).catch(() => undefined)
    const baseProject = localProject ?? project
    const nextFiles = [...baseProject.files]
    const seenFileIds = new Set(nextFiles.map((file) => file.id))
    for (const ref of refs) {
      if (seenFileIds.has(ref.id)) continue
      nextFiles.push(ref)
      seenFileIds.add(ref.id)
    }
    await updateProject({
      ...project,
      ...baseProject,
      sourceLanguage: project.sourceLanguage || baseProject.sourceLanguage,
      targetLanguage: project.targetLanguage || baseProject.targetLanguage,
      syncRole: project.syncRole ?? baseProject.syncRole,
      files: nextFiles,
    })
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
              getTokenForFile={getTokenForFile}
              onSelectFile={workspaceTabs.openFile}
              onRename={handleRename}
              onMove={(fileId) => {
                setMoveTargetId(fileId)
                setMoveCorpus(project.files.find((f) => f.id === fileId)?.corpusMarker ?? "")
              }}
              onDelete={(fileId) => setPendingDeleteId(fileId)}
              onApplySuggestion={handleApplyOneSuggestion}
              onRenameCorpus={handleRenameCorpus}
            />
            <SidebarProjectSection items={projectNavItems} />
          </>
        }
        header={
          <WorkspaceHeader
            project={project}
            onBack={goToProjects}
            extraMenuItems={
              suggestions.length > 0 && project.suggestionsDismissedAt
                ? [{
                    id: "redetect-suggestions",
                    label: `Show ${suggestions.length} file name suggestion${suggestions.length === 1 ? "" : "s"}`,
                    icon: Sparkles,
                    onClick: handleReinviteSuggestions,
                  }]
                : []
            }
          >
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
            {checklistState.totalCount > 0 && checklistState.completedCount < checklistState.totalCount && (
              <TooltipProvider delay={0}>
                <Tooltip open={showChipTooltip} onOpenChange={setShowChipTooltip}>
                  <TooltipTrigger
                    render={
                      <button
                        onClick={() => { setShowChipTooltip(false); setChecklistOpen(true) }}
                        className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent"
                        title="Open setup checklist"
                      />
                    }
                  >
                    <ClipboardList className="h-3 w-3" />
                    Setup: {checklistState.completedCount}/{checklistState.totalCount}
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Reopen the setup checklist anytime from here.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <button
              className="flex items-center gap-1.5 rounded p-1.5 text-sm hover:bg-accent"
              onClick={() => {
                setParallelMode("search")
                setParallelScope(activeFileId ? "file" : "project")
                setParallelOpen(true)
              }}
              title="Search & replace (⌘F)"
            >
              <SearchIcon className="h-4 w-4" />
              <span className="hidden text-xs sm:inline">Search</span>
            </button>
            <NextUnfinishedButton
              onClick={handleJumpNextUnfinished}
              disabled={!activeFileId || !hasUnfinished}
            />
            {project && (
              <SpeakBarToggle
                enabled={speakBarEnabled}
                onToggle={() => setSpeakBarEnabled(project.id, !speakBarEnabled)}
              />
            )}
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
            {project && activeFileId && (
              <>
                {speakBarEnabled && (
                  <VoiceBar
                    project={project}
                    cells={cells}
                    username={currentUsername}
                    session={frontierSession}
                    editorRef={editorRef}
                    onProjectChanged={refresh}
                    onCompleteSingle={completeSingle}
                    onHide={() => setSpeakBarEnabled(project.id, false)}
                  />
                )}
                <SelectionBar
                  project={project}
                  cells={cells}
                  session={frontierSession}
                  username={currentUsername}
                  completeSingle={completeSingle}
                  completeBatch={completeBatch}
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
        main={cellAreaState.kind === "ready" ? (
          <EditorTable
            ref={editorRef} project={project} cells={cells}
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
            onProjectChanged={refresh}
            onCellCommitted={handleCellCommitted}
            cellLockHolders={cellLockHolders}
            cellsWithRemoteChange={cellsWithRemoteChange}
            onClaimCell={handleClaimCell}
            onReleaseCell={handleReleaseCell}
            onAckRemoteChange={handleAckRemoteChange}
            staleCellIds={staleCellIds}
          />
        ) : (
          <CellAreaPlaceholder
            state={cellAreaState}
            fileName={activeFile?.name}
            onImportClick={openImportFlow}
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
              <HistoryDrawer
                cell={historyCell}
                onClose={() => setHistoryCellId(null)}
                projectId={project?.id ?? null}
                fileId={activeFileId}
                getTokenForFile={getTokenForFile}
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
                    pendingCount={outboxPending}
                    failureStreak={outboxFailures}
                    records={outboxRecords}
                  />
                </div>
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
      <Suspense fallback={null}>
        <ImportDialog open={importOpen} onOpenChange={setImportOpen}
          projectId={project.id}
          username={currentUsername}
          getToken={getTokenForFile}
          sourceLanguage={project.sourceLanguage} targetLanguage={project.targetLanguage}
          onImported={handleImported} />
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
        onClearResults={clearSearchResults}
        onSelect={handleSearchSelect}
        username={currentUsername}
        isReadOnly={isReadOnly}
        onAfterReplace={rebuildSearchIndex}
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
        <div className="fixed bottom-4 right-4 z-60 flex items-center gap-2 rounded border bg-background px-3 py-2 text-sm shadow-md">
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
          className="w-full rounded border bg-background px-2 py-1.5 text-sm"
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
            className="mt-2 w-full rounded border bg-background px-2 py-1 text-sm"
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
