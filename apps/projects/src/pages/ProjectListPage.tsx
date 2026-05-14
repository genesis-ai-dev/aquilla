// Project list landing page — the discrete-app port of `src/components/Dashboard.tsx`.
//
// Phase 3c port intent:
//   - Same data shape (cloud project list from auth-worker) but reads through
//     @aquilla/api-client (no IDB local list yet — Phase 3a will decide what
//     parts of project-index.ts move into this app vs the workspace).
//   - Same "log in to see your projects" UX, minus the brand chrome / posthog
//     / OnboardingRedirect logic which lives in workspace concerns.
//
// Source workspace SPA equivalent: src/components/Dashboard.tsx. When Phase 5
// adds the project-shape picker to project-create, it should also land here
// in pages/ProjectCreatePage.tsx — be ready to merge both surfaces.

import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  fetchProjectList,
  type ProjectListItem,
} from "@aquilla/api-client"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Button,
} from "@aquilla/ui"
import { getJwt, redirectToLogin } from "@aquilla/auth-client"

export function ProjectListPage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const jwt = getJwt()
    if (!jwt) {
      redirectToLogin()
      return
    }
    let cancelled = false
    fetchProjectList(jwt)
      .then((list) => {
        if (!cancelled) setProjects(list)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load projects")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const openProject = (projectId: string): void => {
    // Cross-app hard navigation per AD-11 — workspace lives at /w/:id.
    // `window.location.assign` is the lint-friendly form of href mutation;
    // react-compiler's "value cannot be modified" rule fires on direct
    // `window.location.href = ...` but is fine with .assign().
    window.location.assign(`/w/${encodeURIComponent(projectId)}`)
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="flex items-center justify-between gap-2 px-4 py-4 sm:px-6">
          <h1 className="text-xl font-semibold">Projects</h1>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => navigate("/onboarding")}>
              First-time setup
            </Button>
            <Button onClick={() => navigate("/new")}>New project</Button>
          </div>
        </div>
      </header>

      <main className="px-6 py-6">
        {error && (
          <div className="mb-4 rounded border bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <ProjectListSkeleton count={3} />
        ) : projects.length === 0 ? (
          <EmptyState onCreate={() => navigate("/new")} />
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Card
                  role="button"
                  tabIndex={0}
                  onClick={() => openProject(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") openProject(p.id)
                  }}
                  className="cursor-pointer transition hover:shadow-md"
                >
                  <CardHeader>
                    <CardTitle>{p.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    {p.role.name} · {p.files.length} files
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

function ProjectListSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} aria-hidden>
          <CardHeader>
            <Skeleton className="h-6 w-2/3" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-4 w-1/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded border border-dashed bg-card px-6 py-12 text-center">
      <p className="text-sm text-muted-foreground">
        You don&rsquo;t have any projects yet.
      </p>
      <div className="mt-4">
        <Button onClick={onCreate}>Create your first project</Button>
      </div>
    </div>
  )
}
