import { useEffect, useState, useRef } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { ArrowLeft, Download, Upload, Trash2, RotateCcw, Camera, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  listSnapshots, deleteSnapshot, restoreSnapshot,
  exportSnapshotToBlob, importSnapshotFromFile,
} from "@/lib/store/snapshots"
import { getProject } from "@/lib/store/project-index"
import { SnapshotCreateDialog } from "./SnapshotCreateDialog"
import type { ProjectSnapshot, ProjectRecord } from "@/lib/parsers/types"

export function SnapshotsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)  // snapshot id currently being acted on
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function refresh() {
    if (!id) return
    const [proj, snaps] = await Promise.all([getProject(id), listSnapshots(id)])
    if (proj) setProject(proj)
    setSnapshots(snaps)
  }

  useEffect(() => {
    if (!id) return
    setLoading(true)
    refresh().finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function handleRestore(snap: ProjectSnapshot) {
    const ok = window.confirm(
      `Restore "${snap.name}"?\n\nThis will replace current project state with the snapshot. A safety snapshot of the current state will be created first so you can undo.`
    )
    if (!ok) return
    setBusy(snap.id)
    setError(null)
    try {
      await restoreSnapshot(snap.id, project?.username || "anonymous")
      await refresh()
      alert("Snapshot restored. A safety snapshot of the prior state was created automatically.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed")
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(snap: ProjectSnapshot) {
    const ok = window.confirm(`Delete snapshot "${snap.name}"?\n\nThis cannot be undone.`)
    if (!ok) return
    setBusy(snap.id)
    try {
      await deleteSnapshot(snap.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed")
    } finally {
      setBusy(null)
    }
  }

  function handleExport(snap: ProjectSnapshot) {
    const blob = exportSnapshotToBlob(snap)
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${snap.name.replace(/[^a-z0-9]+/gi, "-")}.codex-snapshot.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !id) return
    setError(null)
    try {
      await importSnapshotFromFile(file, id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed")
    }
    // Clear input so the same file can be re-selected later
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function formatTimestamp(iso: string): string {
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

  if (loading) return <div className="p-8 text-muted-foreground">Loading...</div>

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Editor
        </Button>
        <h2 className="font-semibold">Project Snapshots</h2>
        <div className="flex-1" />
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.codex-snapshot,application/json"
          onChange={handleImport}
          className="hidden"
        />
        <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
          <Upload className="mr-1 h-3.5 w-3.5" />
          Import
        </Button>
        {project && <SnapshotCreateDialog projectId={project.id} onCreated={() => refresh()} />}
      </header>

      <main className="mx-auto max-w-3xl space-y-4 p-6">
        {error && (
          <Card>
            <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
          </Card>
        )}

        {snapshots.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              <Camera className="mx-auto mb-2 h-8 w-8 opacity-30" />
              <p>No snapshots yet.</p>
              <p className="mt-1 text-xs">Create one to capture this moment in time.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {snapshots.map((snap) => (
              <Card key={snap.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base flex items-center gap-2">
                        {snap.name}
                        {snap.automatic && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            auto
                          </span>
                        )}
                      </CardTitle>
                      {snap.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{snap.description}</p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRestore(snap)}
                        disabled={busy !== null}
                        title="Restore this snapshot"
                      >
                        {busy === snap.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleExport(snap)}
                        title="Export to file"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(snap)}
                        disabled={busy !== null}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 text-xs text-muted-foreground">
                  <span>{snap.createdBy}</span>
                  <span className="mx-1.5">·</span>
                  <span>{formatTimestamp(snap.createdAt)}</span>
                  <span className="mx-1.5">·</span>
                  <span>{snap.files.length} file{snap.files.length !== 1 ? "s" : ""}</span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
