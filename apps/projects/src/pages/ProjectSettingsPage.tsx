// Project settings page.
//
// Phase 3c stub. The source surface is src/components/ProjectSettings.tsx
// (~650 lines) in the workspace SPA — it depends on a dozen hooks (useProject,
// useProjectSettings, useProjectPermissions, useCompletionSettings, …) that
// haven't been packaged yet. Phase 3a relocates those hooks; once that lands,
// this page receives the full port. Phase 5 also adds a "Source linking" panel
// (link / detach upstream source per AD-9) — merge-aware.

import { Link, useParams } from "react-router-dom"
import { useEffect, useState } from "react"
import { fetchProject, type ProjectDetailResponse } from "@aquilla/api-client"
import { getJwt, redirectToLogin } from "@aquilla/auth-client"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@aquilla/ui"

export function ProjectSettingsPage() {
  const { id } = useParams<{ id: string }>()
  const [project, setProject] = useState<ProjectDetailResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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
        if (!cancelled) setError(err.message ?? "Failed to load project")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-4">
        <Link to="/">
          <Button variant="ghost" size="sm">
            ← All projects
          </Button>
        </Link>
      </div>

      <h1 className="text-2xl font-semibold">Project settings</h1>

      {loading && <p className="mt-4 text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <div className="mt-4 rounded border bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {project && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{project.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Role: <strong>{project.role.name}</strong> ({project.role.source})
            </p>
            <p>{project.files.length} files</p>
            <p className="text-xs">
              Phase 3c scaffold. Full settings UI ports from
              src/components/ProjectSettings.tsx once Phase 3a relocates the
              project hooks into packages/.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
