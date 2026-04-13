import { useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useProject } from "@/hooks/useProject"
import { useFileDoc } from "@/hooks/useFileDoc"
import { useCells } from "@/hooks/useCells"
import { updateProject } from "@/lib/store/project-index"
import type { FileReference } from "@/lib/parsers/types"
import { Toolbar } from "./Toolbar"
import { ProjectSidebar } from "./ProjectSidebar"
import { StatusBar } from "./StatusBar"
import { ImportDialog } from "./ImportDialog"
import { EditorTable } from "./EditorTable"

export function ProjectWorkspace() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { project, loading, refresh } = useProject(projectId!)
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const { doc } = useFileDoc(activeFileId)
  const cells = useCells(doc)

  if (loading || !project) {
    return <div className="p-8 text-muted-foreground">Loading...</div>
  }

  async function handleImported(refs: FileReference[]) {
    if (!project) return
    const updated = {
      ...project,
      files: [...project.files, ...refs],
    }
    await updateProject(updated)
    refresh()
    if (refs.length > 0) {
      setActiveFileId(refs[0].id)
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <Toolbar
        project={project}
        onBack={() => navigate("/")}
        onImport={() => setImportOpen(true)}
        onSettings={() => navigate(`/project/${projectId}/settings`)}
      />
      <div className="flex flex-1 overflow-hidden">
        <ProjectSidebar
          files={project.files}
          activeFileId={activeFileId}
          onSelectFile={setActiveFileId}
        />
        <main className="flex-1 overflow-hidden">
          {activeFileId ? (
            doc ? (
              <EditorTable cells={cells} doc={doc} />
            ) : (
              <p className="p-4 text-muted-foreground">Loading file...</p>
            )
          ) : (
            <p className="p-4 text-muted-foreground">
              Select a file from the sidebar, or import files.
            </p>
          )}
        </main>
      </div>
      <StatusBar cells={cells} />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        sourceLanguage={project.sourceLanguage}
        targetLanguage={project.targetLanguage}
        onImported={handleImported}
      />
    </div>
  )
}
