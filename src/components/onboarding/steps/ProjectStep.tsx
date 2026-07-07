import { useState } from "react"
import { v4 as uuid } from "uuid"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { createProject as createLocalProject } from "@/lib/store/project-index"
import { createRemoteProject } from "@/lib/frontier/members"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { ProjectRecord } from "@/lib/parsers/types"

export function ProjectStep({
  displayName,
  onCreated,
  onBack,
  onSkip,
  orgId,
}: {
  displayName: string
  onCreated: (p: ProjectRecord) => void
  onBack: () => void
  onSkip: () => void
  /** When set (Team onboarding), the project is created inside this org. */
  orgId?: number
}) {
  const [name, setName] = useState("")
  const [sourceLanguage, setSourceLanguage] = useState("")
  const [targetLanguage, setTargetLanguage] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { session } = useFrontierSession()

  // Guard: project creation requires a server session (AD-3 projects are
  // server-only reads; a local-only project will 403 the moment the user
  // opens it after signing in). Mirror ProjectCreateDialog which rejects
  // with "You need to be signed in." on the Dashboard. Show an inline
  // sign-in prompt here rather than silently producing a broken project.
  if (!session?.jwt) {
    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-semibold">Sign in to create a project</h2>
          <p className="text-sm text-muted-foreground">
            Projects are stored on the server. You need to be signed in so the
            project is accessible on all your devices and won't 403 when you
            open it.
          </p>
        </div>
        <Button variant="outline" size="lg" className="w-full" onClick={onBack}>
          ← Back to sign in
        </Button>
        <Button variant="ghost" size="lg" className="w-full" onClick={onSkip}>
          Do this later
        </Button>
      </div>
    )
  }
  const sessionJwt = session.jwt
  const sessionUsername = session.username

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !sourceLanguage.trim() || !targetLanguage.trim()) return
    setBusy(true)
    setError(null)
    try {
      // Create the server row first — reads are server-only (AD-3), so
      // without it the project 403s the moment you open it. Mirror
      // ProjectCreateDialog which enforces this same ordering.
      const created = await createRemoteProject(
        { id: uuid(), name: name.trim() },
        sessionJwt,
        orgId,
      )
      const project: ProjectRecord = {
        id: created.id,
        name: name.trim(),
        sourceLanguage: sourceLanguage.trim(),
        targetLanguage: targetLanguage.trim(),
        createdAt: new Date().toISOString(),
        files: [],
        members: [{ userId: sessionUsername, role: "owner" }],
        username: displayName || sessionUsername,
        syncRole: {
          level: created.role.level,
          name: created.role.name,
          source: created.role.source as "override" | "creator" | "org",
          fetchedAt: new Date().toISOString(),
        },
      }
      await createLocalProject(project)
      onCreated(project)
    } catch (err) {
      // Surface remote-create failures rather than silently navigating to a
      // 404 project page. Common shapes: 401 stale jwt, 409 id collision,
      // 5xx transient.
      const message =
        err instanceof Error ? err.message : "Failed to create project."
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-semibold">Create your first project</h2>
        <p className="text-sm text-muted-foreground">
          You can import files and invite collaborators after setup.
        </p>
      </div>
      <form onSubmit={handleCreate} className="space-y-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="proj-name">Project name</FieldLabel>
            <Input
              id="proj-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Translation Project"
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="src-lang">Source language</FieldLabel>
            <Input
              id="src-lang"
              value={sourceLanguage}
              onChange={(e) => setSourceLanguage(e.target.value)}
              placeholder="English"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="tgt-lang">Target language</FieldLabel>
            <Input
              id="tgt-lang"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              placeholder="French"
            />
          </Field>
        </FieldGroup>
        {error ? (
          <FieldError role="alert">
            {error}
          </FieldError>
        ) : null}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={busy || !name.trim() || !sourceLanguage.trim() || !targetLanguage.trim()}
        >
          {busy ? "Creating…" : "Create Project"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          onClick={onSkip}
          disabled={busy}
        >
          Do this later
        </Button>
      </form>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
