// SnapshotsPage — /project/:id/snapshots route (FRO-176).
//
// Lists all named snapshots for the project. Maintainer+ can create and
// restore; viewer+ can view. Reachable via the /project/:id/snapshots route
// (see App.tsx). ProjectWorkspace shell handles the outer layout, so this
// component only renders the content area (consistent with CommentsPage,
// TerminologyPage, etc.).
//
// SWARM-TODO click-path QA:
//   1. Navigate to /project/:id/snapshots  — snapshot list renders.
//   2. Click "Create snapshot" (maintainer only) → SnapshotCreateDialog opens.
//   3. Enter name + optional description → submit → list refreshes.
//   4. Click "Restore" on a snapshot → SnapshotRestoreDialog shows typed confirmation.
//   5. Type snapshot name → "Restore" button enables → submit → toast with result.
//   6. Click "Delete" → snapshot disappears from list.

import { useState, useMemo } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { Camera, Plus, RotateCcw, Trash2, ArrowLeft, Loader2, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useSnapshots, type Snapshot, type RestoreResult } from "@/hooks/useSnapshots"
import { SnapshotCreateDialog } from "@/components/SnapshotCreateDialog"
import { SnapshotRestoreDialog } from "@/components/SnapshotRestoreDialog"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { useProject } from "@/hooks/useProject"
import { ROLE } from "@/lib/frontier/roles"

/** Sentinel fileId for project-scoped tokens (matches authorize.ts). */
const PROJECT_SENTINEL_FILE_ID = "__project__"

export function SnapshotsPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { session } = useFrontierSession()
  const { project } = useProject(projectId ?? "")

  const [createOpen, setCreateOpen] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<Snapshot | null>(null)
  const [lastRestoreResult, setLastRestoreResult] = useState<RestoreResult | null>(null)

  // Project-scoped token fetcher — snapshots route uses verifyTokenForProject
  // so any file-scoped token for the project works; we use the sentinel.
  const getToken = useMemo((): (() => Promise<string | null>) | undefined => {
    if (!projectId || !session?.jwt) return undefined
    const fileFetcher = buildFileScopedTokenFetcher(() => session.jwt, projectId)
    return () => fileFetcher(PROJECT_SENTINEL_FILE_ID)
  }, [projectId, session?.jwt])

  const { snapshots, isLoading, isError, revalidate, create, remove, restore } =
    useSnapshots({
      projectId: projectId ?? null,
      getToken,
      enabled: !!projectId && !!session?.jwt,
    })

  const roleLevel = project?.syncRole?.level ?? 0
  const canWrite = roleLevel >= ROLE.MAINTAINER

  function handleRestored(result: RestoreResult) {
    setLastRestoreResult(result)
    revalidate()
  }

  async function handleDelete(snap: Snapshot) {
    if (!window.confirm(`Delete snapshot "${snap.name}"? This cannot be undone.`)) return
    try {
      await remove(snap.id)
    } catch (err) {
      console.error("[SnapshotsPage] delete failed:", err)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(`/project/${projectId ?? ""}`)}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1">
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Camera className="h-5 w-5 text-muted-foreground" />
              Snapshots
            </h1>
            {project?.name && (
              <p className="text-sm text-muted-foreground">{project.name}</p>
            )}
          </div>
          {canWrite && (
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <Plus className="h-4 w-4 mr-1" />
              Create snapshot
            </Button>
          )}
        </div>

        {/* Restore result toast-like banner */}
        {lastRestoreResult && (
          <div className="rounded-md border bg-green-50 text-green-800 px-4 py-3 text-sm flex items-start gap-2">
            <span className="flex-1">{lastRestoreResult.message}</span>
            <button
              className="text-green-600 hover:text-green-800"
              onClick={() => setLastRestoreResult(null)}
            >
              ×
            </button>
          </div>
        )}

        {/* Loading / error states */}
        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading snapshots…
          </div>
        )}
        {isError && !isLoading && (
          <div className="flex items-center gap-2 text-destructive text-sm py-12 justify-center">
            <AlertCircle className="h-4 w-4" />
            Failed to load snapshots.{" "}
            <button className="underline" onClick={revalidate}>Retry</button>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !isError && snapshots.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <Camera className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                No snapshots yet.
                {canWrite && " Create one to save a labeled point-in-time copy of this project."}
              </p>
              {canWrite && (
                <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Create first snapshot
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Snapshot list */}
        {!isLoading && snapshots.length > 0 && (
          <div className="space-y-2">
            {snapshots.map((snap) => (
              <Card key={snap.id}>
                <CardContent className="flex items-start gap-4 py-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{snap.name}</span>
                      <Badge variant="secondary" className="text-xs shrink-0">
                        {new Date(snap.snapshotTs).toLocaleDateString()}
                      </Badge>
                    </div>
                    {snap.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {snap.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      by {snap.createdBy} ·{" "}
                      {new Date(snap.snapshotTs).toLocaleString()}
                    </p>
                  </div>
                  {canWrite && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRestoreTarget(snap)}
                        title="Restore to this snapshot"
                      >
                        <RotateCcw className="h-3.5 w-3.5 mr-1" />
                        Restore
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => void handleDelete(snap)}
                        title="Delete snapshot"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <SnapshotCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={create}
      />

      <SnapshotRestoreDialog
        open={!!restoreTarget}
        onOpenChange={(open) => { if (!open) setRestoreTarget(null) }}
        snapshot={restoreTarget}
        onRestore={restore}
        onRestored={handleRestored}
      />
    </div>
  )
}
