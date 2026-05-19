// Project create flow.
//
// Minimal first-version: name only. The shape picker (self-contained /
// source-only / linked target per AD-9) is still deferred to Phase 5; a
// new project is shaped as `self-contained` until the user adds a source
// link from project settings. Server creates the user's personal org if
// missing and stamps the caller as `owner`.

import { useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import {
  createProject,
  type CreatedProject,
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
  FormRow,
  Input,
} from "@aquilla/ui"

/** Generate a v4-shape UUID. crypto.randomUUID is unavailable on a few
 *  edge cases (insecure context, very old Safari) — fall back to a
 *  Math.random shim then. */
function newProjectId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  const r = (n: number) =>
    Array.from({ length: n }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join("")
  return `${r(8)}-${r(4)}-4${r(3)}-${["8", "9", "a", "b"][Math.floor(Math.random() * 4)]}${r(3)}-${r(12)}`
}

export function ProjectCreatePage() {
  const [name, setName] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (submitting) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError("Project needs a name.")
      return
    }
    const jwt = getJwt()
    if (!jwt) {
      redirectToLogin()
      return
    }
    setError(null)
    setSubmitting(true)
    let created: CreatedProject
    try {
      created = await createProject({ id: newProjectId(), name: trimmed }, jwt)
    } catch (err) {
      setSubmitting(false)
      if (err && typeof err === "object" && (err as { status?: number }).status === 401) {
        handleAuthExpiredAndRedirect()
        return
      }
      setError(err instanceof Error ? err.message : "Couldn't create project")
      return
    }
    // Cross-app navigation: workspace lives at /w/:id, served by a
    // different worker.
    window.location.assign(`/w/${encodeURIComponent(created.id)}`)
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader
        title="New project"
        titleHref="/projects/"
        actions={
          <Link to="/">
            <Button variant="ghost" size="sm">
              ← All projects
            </Button>
          </Link>
        }
      />
      <div className="mx-auto max-w-xl px-6 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Create a project</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <Alert tone="error" role="alert">
                {error}
              </Alert>
            )}
            <FormRow label="Project name" htmlFor="project-name">
              <Input
                id="project-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Mark — French target"
                disabled={submitting}
                required
              />
            </FormRow>
            <div className="flex justify-end gap-2 pt-2">
              <Link to="/">
                <Button variant="outline" type="button" disabled={submitting}>
                  Cancel
                </Button>
              </Link>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create project"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      </div>
    </div>
  )
}
