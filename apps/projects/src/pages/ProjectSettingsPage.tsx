// Project settings page.
//
// First-version surface: shows project name, caller's role, file count;
// owners can archive (soft-delete). The fuller settings UI from
// src/components/ProjectSettings.tsx (~650 lines: rules, completion
// settings, source-linking, snapshots) ports once those hooks are
// extracted into shared packages — see Phase 3a.
//
// Server endpoint: POST /api/v2/projects/:id/archive — owner-only,
// soft-delete (sets archived_at timestamp; restorable via DELETE on the
// same path).

import { Link, useParams } from "react-router-dom"
import { useEffect, useState } from "react"
import {
  fetchProject,
  archiveProject,
  type ProjectDetailResponse,
} from "@aquilla/api-client"
import {
  getJwt,
  redirectToLogin,
  handleAuthExpiredAndRedirect,
} from "@aquilla/auth-client"
import {
  Alert,
  AppHeader,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@aquilla/ui"

export function ProjectSettingsPage() {
  const { id } = useParams<{ id: string }>()
  const [project, setProject] = useState<ProjectDetailResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [archiving, setArchiving] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)

  useEffect(() => {
    if (!id) return
    const jwt = getJwt()
    if (!jwt) {
      redirectToLogin()
      return
    }
    let cancelled = false
    fetchProject(id, jwt)
      .then((p) => {
        if (!cancelled) setProject(p)
      })
      .catch((err) => {
        if (cancelled) return
        if (err && typeof err === "object" && err.status === 401) {
          handleAuthExpiredAndRedirect()
          return
        }
        setError(err.message ?? "Failed to load project")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  async function handleArchive(): Promise<void> {
    if (!id || archiving) return
    const jwt = getJwt()
    if (!jwt) {
      redirectToLogin()
      return
    }
    setArchiving(true)
    setError(null)
    try {
      await archiveProject(id, jwt)
    } catch (err) {
      setArchiving(false)
      if (err && typeof err === "object" && (err as { status?: number }).status === 401) {
        handleAuthExpiredAndRedirect()
        return
      }
      setError(
        err instanceof Error ? err.message : "Couldn't archive project",
      )
      return
    }
    // Server confirmed — bounce back to the dashboard. The list query
    // will run on mount and the archived row won't appear.
    window.location.assign("/projects/")
  }

  const isOwner = project?.role.level === 700

  return (
    <div className="min-h-screen bg-background">
      <AppHeader
        title="Project settings"
        titleHref="/projects/"
        actions={
          <Link to="/">
            <Button variant="ghost" size="sm">
              ← All projects
            </Button>
          </Link>
        }
      />
      <div className="mx-auto max-w-3xl px-6 py-8">

      {loading && <p className="mt-4 text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <Alert tone="error" className="mt-4" role="alert">
          {error}
        </Alert>
      )}

      {project && (
        <>
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>{project.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                Role: <strong>{project.role.name}</strong> ({project.role.source})
              </p>
              <p>{project.files.length} files</p>
              <div className="pt-2">
                <Link to={`/w/${encodeURIComponent(project.id)}`}>
                  <Button variant="outline" size="sm">
                    Open in workspace
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>

          {isOwner && (
            <Card className="mt-6 border-destructive/30">
              <CardHeader>
                <CardTitle className="text-destructive">Danger zone</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  Archiving hides this project from your dashboard. Owners can
                  restore an archived project with the same name within 30 days
                  (after which the project's data is permanently deleted).
                </p>
                {!confirmArchive ? (
                  <Button
                    variant="outline"
                    onClick={() => setConfirmArchive(true)}
                  >
                    Archive project
                  </Button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      Archive &ldquo;{project.name}&rdquo;?
                    </span>
                    <Button
                      onClick={handleArchive}
                      disabled={archiving}
                    >
                      {archiving ? "Archiving…" : "Confirm archive"}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmArchive(false)}
                      disabled={archiving}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
      </div>
    </div>
  )
}
