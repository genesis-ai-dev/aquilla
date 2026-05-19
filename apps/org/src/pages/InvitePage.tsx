// Per-project invite flow.
//
// First-version surface: pick one of your projects, choose a role + email,
// mint a share-link invite. Server returns the token + a sharable URL the
// invitee can open to join. Per LINK_ROLE_CAP on the server, link-share
// invites are capped at `contributor` (400) — managerial roles need to be
// granted via the org members surface, not URL.
//
// Multi-project bulk invite (the original
// src/components/MultiProjectInviteDialog.tsx flow) is deferred — it'd
// need a server endpoint that mints multiple tokens in one transaction;
// the per-project endpoint is the only one wired today.

import { useEffect, useState, useCallback, type FormEvent } from "react"
import { Link } from "react-router-dom"
import {
  fetchProjectList,
  createProjectInvite,
  type ProjectListItem,
  type CreatedProjectInvite,
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

/** Roles available for link-share invites. Server caps at contributor. */
const SHAREABLE_ROLES: Array<{ level: number; name: string; help: string }> = [
  { level: 100, name: "viewer", help: "Read-only access" },
  { level: 200, name: "commenter", help: "Can comment but not edit" },
  { level: 300, name: "reviewer", help: "Can validate cells" },
  { level: 400, name: "contributor", help: "Can edit translations" },
]

/** Server-side INVITE_MIN_ROLE — only project_lead+ can mint invites. */
const MIN_INVITER_ROLE_LEVEL = 500

export function InvitePage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([])
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [selectedProjectId, setSelectedProjectId] = useState<string>("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<number>(400)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedProjectInvite | null>(null)

  const handleAuthError = useCallback((err: unknown): boolean => {
    if (err && typeof err === "object" && (err as { status?: number }).status === 401) {
      handleAuthExpiredAndRedirect()
      return true
    }
    return false
  }, [])

  useEffect(() => {
    const jwt = getJwt()
    if (!jwt) {
      redirectToLogin()
      return
    }
    let cancelled = false
    fetchProjectList(jwt)
      .then((list) => {
        if (cancelled) return
        // Only show projects where the caller has a high enough role to
        // mint invites — anything below project_lead the server will 403
        // anyway.
        const eligible = list.filter(
          (p) => p.role.level >= MIN_INVITER_ROLE_LEVEL,
        )
        setProjects(eligible)
        if (eligible[0]) setSelectedProjectId(eligible[0].id)
      })
      .catch((err) => {
        if (cancelled) return
        if (handleAuthError(err)) return
        setError(err.message ?? "Failed to load your projects")
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false)
      })
    return () => {
      cancelled = true
    }
  }, [handleAuthError])

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (submitting || !selectedProjectId) return
    const jwt = getJwt()
    if (!jwt) {
      redirectToLogin()
      return
    }
    setError(null)
    setSubmitting(true)
    setCreated(null)
    try {
      const invite = await createProjectInvite(
        selectedProjectId,
        { role, email: email.trim() || undefined },
        jwt,
      )
      setCreated(invite)
    } catch (err) {
      if (handleAuthError(err)) return
      setError(err instanceof Error ? err.message : "Couldn't create invite")
    } finally {
      setSubmitting(false)
    }
  }

  async function copyInviteLink(): Promise<void> {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.url)
    } catch {
      // Clipboard permission denied; user can still copy manually.
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader
        title="Invite"
        titleHref="/org/"
        actions={
          <Link to="/">
            <Button variant="ghost" size="sm">
              ← Organization
            </Button>
          </Link>
        }
      />
      <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Invite to a project</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Mint a share-link invite for one of your projects. Anyone with the
        link can join at the role you choose.
      </p>

      {loadingProjects && (
        <p className="mt-6 text-sm text-muted-foreground">
          Loading your projects…
        </p>
      )}
      {error && (
        <Alert tone="error" className="mt-4" role="alert">
          {error}
        </Alert>
      )}

      {!loadingProjects && projects.length === 0 && !error && (
        <Alert tone="info" className="mt-6">
          You need to be a project lead or higher on at least one project to
          mint invites. Create or join a project first.
        </Alert>
      )}

      {!loadingProjects && projects.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>New invite</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <FormRow label="Project" htmlFor="invite-project">
                <select
                  id="invite-project"
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  disabled={submitting}
                  className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </FormRow>

              <FormRow
                label="Email (optional)"
                htmlFor="invite-email"
                hint="If set, only this email can redeem the invite."
              >
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="alice@example.com"
                  disabled={submitting}
                />
              </FormRow>

              <FormRow label="Role" htmlFor="invite-role">
                <select
                  id="invite-role"
                  value={role}
                  onChange={(e) => setRole(Number(e.target.value))}
                  disabled={submitting}
                  className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {SHAREABLE_ROLES.map((r) => (
                    <option key={r.level} value={r.level}>
                      {r.name} — {r.help}
                    </option>
                  ))}
                </select>
              </FormRow>

              <div className="flex justify-end pt-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Creating invite…" : "Create invite"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {created && (
        <Card className="mt-6 border-emerald-500/30">
          <CardHeader>
            <CardTitle>Invite ready</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Share this link. Expires {formatExpiry(created.expiresAt)}.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                readOnly
                value={created.url}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="font-mono text-xs"
              />
              <Button variant="outline" size="sm" onClick={copyInviteLink}>
                Copy
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  )
}

function formatExpiry(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const days = Math.round((t - Date.now()) / 86_400_000)
  if (days <= 0) return "soon"
  if (days === 1) return "in 1 day"
  return `in ${days} days`
}
