import { useState, useMemo, useRef, useEffect, useCallback } from "react"
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

export function ProjectWorkspace() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { project, loading, refresh } = useProject(projectId!)
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [drawerRuleId, setDrawerRuleId] = useState<string | null>(null)
  const [commentsCellId, setCommentsCellId] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const editorRef = useRef<EditorTableHandle>(null)
  const { doc } = useFileDoc(activeFileId)
  const cells = useCells(doc)

  const { buildIndex, search: runSearch, results: searchResults, loading: searchLoading, ready: searchReady } = useWorkspaceSearch(project?.files || [])
  const { search } = useSearchIndex(project?.files || [], cells)
  const { completeSingle, completeBatch, isConfigured, completing, examples, errors } = useCompletion(
    doc, project?.completionSettings, project?.sourceLanguage || "", project?.targetLanguage || "", search
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
    findBacktranslationExamples
  )

  const { rules, penalties } = useRules(project ?? null, refresh)
  const { addThread, addMessage, resolveThread, reopenThread } = useComments(doc, project?.username || "anonymous")
  const commentsCell = commentsCellId ? cells.find((c) => c.id === commentsCellId) : null

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
        exportEnabled={Boolean(activeFileId)}
      />
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
              <EditorTable ref={editorRef} cells={cells} doc={doc} username={project.username || "local"}
                isCompletionConfigured={isConfigured} completing={completing} examples={examples} errors={errors}
                onCompleteSingle={completeSingle} onCompleteBatch={completeBatch}
                healthMap={healthMap}
                infractions={infractions}
                rules={rules}
                onInfractionClick={(ruleId) => {
                  setCommentsCellId(null)
                  setDrawerRuleId(ruleId)
                }}
                isBacktranslationConfigured={isBacktranslationConfigured}
                onBacktranslate={runBacktranslation}
                backtranslating={backtranslating}
                backtranslationErrors={backtranslationErrors}
                cellOpenCommentCount={cellOpenCommentCount}
                onOpenComments={(cellId) => {
                  setDrawerRuleId(null)
                  setCommentsCellId(cellId)
                }}
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
              cell={commentsCell}
              onClose={() => setCommentsCellId(null)}
              onNewThread={(text) => addThread(commentsCell.id, text)}
              onReply={(threadId, text) => addMessage(commentsCell.id, threadId, text)}
              onResolve={(threadId, msg) => resolveThread(commentsCell.id, threadId, msg)}
              onReopen={(threadId) => reopenThread(commentsCell.id, threadId)}
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
    </div>
  )
}
