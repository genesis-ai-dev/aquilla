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
import { Toolbar } from "./Toolbar"
import { ProjectSidebar } from "./ProjectSidebar"
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
import { useCellLabelsPreference } from "./ViewSettingsMenu"
import { peerColor as peerColorLocal } from "@/lib/sync/webrtc-provider"
import { startBootstrapHost } from "@/lib/sync/bootstrap"
import { listShares } from "@/lib/sync/share-tokens"
import { useProjectPermissions } from "@/hooks/useProjectPermissions"
import { useSyncProject } from "@/hooks/useSyncProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useAutoSync } from "@/hooks/useAutoSync"
import { useCorpusBackfill } from "@/hooks/useCorpusBackfill"
import { Lock } from "lucide-react"

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
  const cells = useCells(doc)
  const fileMeta = useFileMeta(doc, project?.targetLanguage)
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
  const { session: frontierSession } = useFrontierSession()
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
  const { addThread, addMessage, resolveThread, reopenThread } = useComments(doc, project?.username || "anonymous")
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

  const { healthMap, fileHealth, projectHealth, fileProgress, infractions, openCommentCount, cellOpenCommentCount } = useHealth(
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
    username: project?.username || "anonymous",
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
    username: project?.username || "anonymous",
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
      name: project?.username || "anonymous",
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

  const handleProjectUpdated = useCallback(async (updated: typeof project) => {
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

  if (loading || !project) return <div className="p-8 text-muted-foreground">Loading...</div>

  async function handleImported(refs: FileReference[]) {
    if (!project) return
    await updateProject({ ...project, files: [...project.files, ...refs] })
    refresh()
    if (refs.length > 0) setActiveFileId(refs[0].id)
  }

  async function handleExport() {
    if (!activeFileId) return
    try {
      const { blob, filename } = await exportFile(activeFileId)
      downloadBlob(blob, filename)
    } catch (err) {
      alert(`Export failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <Toolbar
        project={project}
        onBack={() => navigate("/")}
        onImport={() => setImportOpen(true)}
        onSettings={() => navigate(`/project/${projectId}/settings`)}
        onRules={() => navigate(`/project/${projectId}/rules`)}
        onExport={handleExport}
        onSearch={() => setSearchOpen(true)}
        onComments={() => navigate(`/project/${projectId}/comments`)}
        onSnapshots={() => navigate(`/project/${projectId}/snapshots`)}
        onShare={() => setShareOpen(true)}
        peers={peers}
        exportEnabled={Boolean(activeFileId)}
        fileOpen={Boolean(activeFileId)}
        lineNumbersEnabled={fileMeta.lineNumbersEnabled}
        textDirection={fileMeta.textDirection}
        cellLabelsEnabled={cellLabelsEnabled}
        onLineNumbersChange={fileMeta.setLineNumbersEnabled}
        onTextDirectionChange={fileMeta.setTextDirection}
        onCellLabelsChange={setCellLabelsEnabled}
        onVideo={isSubtitleFile ? () => setVideoDialogOpen(true) : undefined}
        onProjectUpdated={handleProjectUpdated}
        sync={runSync}
        syncPhase={syncPhase}
        syncInFlight={syncInFlight}
        syncLastResult={syncLastResult}
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
      <div className="flex flex-1 overflow-hidden">
        <ProjectSidebar
          files={project.files}
          activeFileId={activeFileId}
          onSelectFile={setActiveFileId}
          fileHealth={fileHealth}
          fileProgress={fileProgress}
          projectHealth={projectHealth}
          openCommentCount={openCommentCount}
        />
        <main className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden">
            {activeFileId ? (doc ? (
              <EditorTable ref={editorRef} project={project} cells={cells} doc={doc} username={project.username || "local"}
                isCompletionConfigured={isConfigured} completing={completing} examples={examples} errors={errors}
                onCompleteSingle={completeSingle} onCompleteBatch={completeBatch}
                healthMap={healthMap}
                infractions={infractions}
                rules={rules}
                onInfractionClick={(ruleId) => {
                  setCommentsCellId(null)
                  setHistoryCellId(null)
                  setDrawerRuleId(ruleId)
                }}
                isBacktranslationConfigured={isBacktranslationConfigured}
                onBacktranslate={runBacktranslation}
                backtranslating={backtranslating}
                backtranslationErrors={backtranslationErrors}
                cellOpenCommentCount={cellOpenCommentCount}
                onOpenComments={(cellId) => {
                  setDrawerRuleId(null)
                  setHistoryCellId(null)
                  setCommentsCellId(cellId)
                }}
                onOpenHistory={(cellId) => {
                  setDrawerRuleId(null)
                  setCommentsCellId(null)
                  setHistoryCellId(cellId)
                }}
                syncProvider={syncProvider}
                collabUser={collabUser}
                activeCueIndex={activeCueIndex >= 0 ? activeCueIndex : undefined}
                onSeekToCue={isSubtitleFile ? handleCueSeek : undefined}
                lineNumbersEnabled={fileMeta.lineNumbersEnabled}
                cellLabelsEnabled={cellLabelsEnabled}
                textDirection={fileMeta.textDirection}
              />
            ) : <p className="p-4 text-muted-foreground">Loading file...</p>) : (
              <p className="p-4 text-muted-foreground">Select a file from the sidebar, or import files.</p>
            )}
          </div>
          {drawerRuleId && (
            <RuleDrawer
              rule={drawerRule}
              infractions={drawerInfractions}
              cells={cells}
              onClose={() => setDrawerRuleId(null)}
              onNavigateToCell={(_cellId) => {
                // TODO: scroll virtualizer to cell
              }}
            />
          )}
          {commentsCell && (
            <CommentsDrawer
              project={project}
              cell={commentsCell}
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
            />
          )}
        </main>
      </div>
      <StatusBar cells={cells} projectHealth={projectHealth} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} sourceLanguage={project.sourceLanguage} targetLanguage={project.targetLanguage} onImported={handleImported} />
      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onReady={buildIndex}
        loading={searchLoading}
        ready={searchReady}
        results={searchResults}
        onSearch={runSearch}
        onSelect={handleSearchSelect}
      />
      <SharePanel
        open={shareOpen}
        onOpenChange={setShareOpen}
        projectId={projectId!}
        username={project.username || "anonymous"}
        onSharesChanged={() => setShareRefreshKey((k) => k + 1)}
      />
      <VideoAttachmentDialog
        open={videoDialogOpen}
        onOpenChange={setVideoDialogOpen}
        current={videoAttachment}
        onSave={saveVideo}
      />
    </div>
  )
}
