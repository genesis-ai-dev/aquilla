import { useState, useMemo, useRef, useEffect, useCallback } from "react"
import * as Y from "yjs"
import { useParams, useNavigate } from "react-router-dom"
import { useProject } from "@/hooks/useProject"
import { useFileDoc } from "@/hooks/useFileDoc"
import { useCells } from "@/hooks/useCells"
import { useSearchIndex } from "@/hooks/useSearchIndex"
import { useCompletion } from "@/hooks/useCompletion"
import { useHealth } from "@/hooks/useHealth"
import { useRules } from "@/hooks/useRules"
import { updateProject } from "@/lib/store/project-index"
import { exportFile, downloadBlob } from "@/lib/export/export-service"
import type { FileReference } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { useWorkspaceSearch } from "@/hooks/useWorkspaceSearch"
import { useBacktranslation } from "@/hooks/useBacktranslation"
import { useComments } from "@/hooks/useComments"
import { SearchDialog } from "./SearchDialog"
import type { EditorTableHandle } from "./EditorTable"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"
import { StatusBar } from "./StatusBar"
import { ImportDialog } from "./ImportDialog"
import { EditorTable } from "./EditorTable"
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
import { useFileMeta } from "@/hooks/useFileMeta"
import { useCellLabelsPreference } from "@/hooks/useCellLabelsPreference"
import { peerColor as peerColorLocal } from "@/lib/sync/webrtc-provider"
import { startBootstrapHost } from "@/lib/sync/bootstrap"
import { listShares } from "@/lib/sync/share-tokens"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { useSyncProject } from "@/hooks/useSyncProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useAutoSync } from "@/hooks/useAutoSync"
import { useCorpusBackfill } from "@/hooks/useCorpusBackfill"
import { Film, Scale, MessagesSquare, Camera, Share2, Settings as SettingsIcon, Lock, ClipboardList } from "lucide-react"
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
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useSetupChecklist } from "@/hooks/useSetupChecklist"
import { SetupChecklistDrawer } from "./onboarding/SetupChecklistDrawer"

export function ProjectWorkspace() {
  const { id: projectId, fileId: routeFileId } = useParams<{ id: string; fileId?: string }>()
  const navigate = useNavigate()
  const { project, loading, refresh } = useProject(projectId!)

  const activeFileId = routeFileId ?? null

  const setActiveFileId = useCallback((fileId: string | null) => {
    if (!projectId) return
    if (fileId) {
      navigate(`/project/${projectId}/file/${fileId}`)
    } else {
      navigate(`/project/${projectId}`)
    }
  }, [projectId, navigate])
  const [importOpen, setImportOpen] = useState(false)
  const [drawerRuleId, setDrawerRuleId] = useState<string | null>(null)
  const [commentsCellId, setCommentsCellId] = useState<string | null>(null)
  const [historyCellId, setHistoryCellId] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [activeShareToken, setActiveShareToken] = useState<string | null>(null)
  const [shareRefreshKey, setShareRefreshKey] = useState(0)
  const editorRef = useRef<EditorTableHandle>(null)
  const { doc } = useFileDoc(activeFileId)
  // Prefer the Frontier session username (authenticated identity) over the
  // project-level username setting. Validation entries and edit history
  // should attribute to the actual signed-in user.
  const { session: frontierSession } = useFrontierSession()
  const currentUsername = frontierSession?.username || project?.username || "local"
  const cells = useCells(doc, currentUsername)
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

  const { buildIndex, search: runSearch, results: searchResults, loading: searchLoading, ready: searchReady } = useWorkspaceSearch(project?.files || [])
  const { search } = useSearchIndex(project?.files || [], cells)
  const { completeSingle, completeBatch, isConfigured, completing, examples, errors } = useCompletion(
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

  const { healthMap, fileHealth: _fileHealth, projectHealth, fileProgress, infractions, openCommentCount, cellOpenCommentCount } = useHealth(
    fileCells,
    project?.completionSettings?.llmHealthPenalty ?? 0.1,
    rules,
    penalties
  )

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
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [])

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

  const syncRoom = activeShareToken && activeFileId ? `codex:share:${activeShareToken}:file:${activeFileId}` : null
  const { peers: fileLevelPeers, provider: syncProvider } = useSync({
    doc,
    roomName: syncRoom,
    username: currentUsername,
    currentFileId: activeFileId || undefined,
    enabled: Boolean(syncRoom),
  })

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
      name: currentUsername,
      color: peerColorLocal(clientId),
    }
  }, [syncProvider, project?.username])

  async function handleSearchSelect(result: WorkspaceSearchResult) {
    if (result.fileId !== activeFileId) {
      setActiveFileId(result.fileId)
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

  useEffect(() => {
    if (!checklistDismissed) setChecklistOpen(true)
  }, [checklistDismissed])

  const handleProjectUpdated = useCallback(async (updated: ProjectRecord | undefined) => {
    if (!updated) return
    await updateProject(updated)
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
            handleProjectUpdated({ ...project, origin: { ...project.origin, headSha: r.commitSha } })
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
      const next = renameFile(project, fileId, newName)
      await updateProject(next)
      refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : "Rename failed")
    }
  }, [project, refresh])

  const handleDeleteFile = useCallback(async (fileId: string) => {
    if (!project) return
    const next = deleteFile(project, fileId)
    await updateProject(next)
    refresh()
    if (activeFileId === fileId) setActiveFileId(null)
  }, [project, refresh, activeFileId, setActiveFileId])

  const handleApplySuggestions = useCallback(async (chosen: RenameSuggestion[]) => {
    if (!project) return
    const before = project
    const next = applySuggestions(project, chosen)
    await updateProject(next)
    refresh()
    setUndo({ project: before })
    setTimeout(() => setUndo((u) => (u?.project === before ? null : u)), 10000)
  }, [project, refresh])

  const handleDismissBanner = useCallback(async () => {
    if (!project) return
    const next = { ...project, suggestionsDismissedAt: new Date().toISOString() }
    await updateProject(next)
    refresh()
  }, [project, refresh])

  const projectNavItems = useMemo(() => ([
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
  ]), [projectId, navigate, openCommentCount])

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

  if (loading || !project) return <div className="p-8 text-muted-foreground">Loading...</div>

  async function handleImported(refs: FileReference[]) {
    if (!project) return
    await updateProject({ ...project, files: [...project.files, ...refs] })
    refresh()
    if (refs.length > 0) setActiveFileId(refs[0].id)
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
              activeFileCells={cells}
              fileProgress={fileProgress}
              suggestionFileIds={suggestionFileIds}
              onSelectFile={setActiveFileId}
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
            <PrimaryActionButton ctx={actionCtx} run={actionArgs} />
          </WorkspaceHeader>
        }
        beforeMain={
          <>
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
        main={activeFileId ? (doc ? (
          <EditorTable
            ref={editorRef} project={project} cells={cells} doc={doc}
            username={currentUsername}
            isCompletionConfigured={isConfigured} completing={completing}
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
          />
        ) : <p className="p-4 text-muted-foreground">Loading file...</p>) : (
          <p className="p-4 text-muted-foreground">Select a file from the sidebar, or use + Import.</p>
        )}
        aside={
          <>
            {drawerRuleId && (
              <RuleDrawer
                rule={drawerRule} infractions={drawerInfractions} cells={cells}
                onClose={() => setDrawerRuleId(null)}
                onNavigateToCell={() => {}}
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
              left={<PeerPresence peers={peers} />}
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
            <StatusBar cells={cells} projectHealth={projectHealth} />
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
      <ImportDialog open={importOpen} onOpenChange={setImportOpen}
        sourceLanguage={project.sourceLanguage} targetLanguage={project.targetLanguage}
        onImported={handleImported} />
      <SearchDialog
        open={searchOpen} onOpenChange={setSearchOpen}
        onReady={buildIndex} loading={searchLoading} ready={searchReady}
        results={searchResults} onSearch={runSearch} onSelect={handleSearchSelect}
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
              const next = moveFileToCorpus(project, moveTargetId, moveCorpus)
              await updateProject(next)
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
    const groupId = editorScroll.pendingGroup
    if (!groupId) return
    const idx = cells.findIndex((c) => (c.group ?? "Ungrouped") === groupId)
    editorScroll.consume()
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
