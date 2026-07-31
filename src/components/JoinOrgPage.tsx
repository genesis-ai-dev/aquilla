import { useEffect, useState, type ReactNode } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { AlertCircle, Users, CheckCircle2 } from "lucide-react"
import { orgHomePath } from "@/lib/navigation/org-paths"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  acceptOrgInvite,
  previewOrgInvite,
  type OrgInvitePreview,
} from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { isJwtExpired } from "@/lib/frontier/auth"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { FrontierSignupForm } from "@/components/git-import/FrontierSignupForm"
import { UserError } from "@/lib/errors/user-error"
import posthog from "@/lib/posthog"
import { INVITE_REDEEMED } from "@/lib/event-names"

type Phase = "initial" | "redeeming" | "done" | "error"
type AuthMode = "login" | "signup"

function JoinOrgShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  )
}

/**
 * Organization invite landing page (/join-org/:token). The token identifies an
 * org_invites row; redeeming it adds the caller to org_members at the invited
 * role. Like the project JoinPage, membership requires a signed-in account, so
 * signed-out users get inline auth first. A public preview (AQU-471) names the
 * org, the inviter, and the role before accepting; if it fails we fall back to
 * the old generic copy — the accept endpoint stays the authority on validity.
 */
export function JoinOrgPage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { session, loading: sessionLoading } = useFrontierSession()
  const [phase, setPhase] = useState<Phase>("initial")
  const [error, setError] = useState<string | null>(null)
  const [orgName, setOrgName] = useState<string | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>("login")
  const [preview, setPreview] = useState<OrgInvitePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(true)

  // Public preview — who invited you, to which org, at what role (AQU-471).
  useEffect(() => {
    if (!token) return
    let cancelled = false
    void previewOrgInvite(token).then((p) => {
      if (cancelled) return
      setPreview(p)
      setPreviewLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [token])

  const previewSummary = preview ? (
    <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
      <p className="text-sm">
        Organization:{" "}
        <strong className="font-medium">{preview.orgName ?? "Unnamed organization"}</strong>
      </p>
      <p className="text-xs text-muted-foreground">
        {preview.invitedBy && (
          <>
            Invited by <span className="font-medium">{preview.invitedBy}</span> —{" "}
          </>
        )}
        you&apos;ll join as{" "}
        <span className="capitalize">{preview.role.name.replace(/_/g, " ")}</span>
        {preview.email && (
          <>
            {" "}— invitation sent to <span className="font-mono">{preview.email}</span>
          </>
        )}
        .
      </p>
    </div>
  ) : previewLoading ? (
    <div className="flex items-center gap-2 py-1">
      <Spinner className="text-muted-foreground" />
      <p className="text-xs text-muted-foreground">Loading invitation details…</p>
    </div>
  ) : (
    <p className="text-sm text-muted-foreground">
      You&apos;ve been invited to join an organization on Aquilla.
    </p>
  )

  const sessionExpired = !!session?.jwt && isJwtExpired(session.jwt)
  const hasValidSession = !!session?.jwt && !sessionExpired

  async function accept(jwt: string) {
    if (!token) return
    setPhase("redeeming")
    setError(null)
    try {
      const result = await acceptOrgInvite(jwt, token)
      posthog.capture(INVITE_REDEEMED, { invite_kind: "org", org_id: result.orgId })
      setOrgName(result.orgName)
      setPhase("done")
      setTimeout(() => navigate(orgHomePath(result.orgId)), 1200)
    } catch (err) {
      const status = err instanceof UserError ? err.status : undefined
      if (status === 403) {
        setError("This invite was sent to a different email address. Sign in with the invited account.")
      } else if (status === 410) {
        setError("This invite link has expired or was already used. Ask the org owner for a fresh one.")
      } else if (status === 404) {
        setError("This invite link is invalid. Ask the org owner for a fresh one.")
      } else if (isJwtExpired(jwt)) {
        setPhase("initial")
        return
      } else {
        setError("Couldn't join the organization. Please try again.")
      }
      setPhase("error")
    }
  }

  if (!token) {
    return (
      <JoinOrgShell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="size-5 text-destructive" /> Invalid invite link
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => navigate("/")}>Go home</Button>
        </CardContent>
      </JoinOrgShell>
    )
  }

  if (phase === "error") {
    return (
      <JoinOrgShell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="size-5 text-destructive" /> Can't join
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={() => navigate("/")}>Go home</Button>
        </CardContent>
      </JoinOrgShell>
    )
  }

  if (phase === "done") {
    return (
      <JoinOrgShell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-green-600" /> You're in
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Joined {orgName ?? "the organization"}. Taking you there…
          </p>
        </CardContent>
      </JoinOrgShell>
    )
  }

  if (sessionLoading) {
    return (
      <JoinOrgShell>
        <CardContent className="flex items-center justify-center py-10">
          <Spinner className="mr-2" /> <span className="text-sm">Loading…</span>
        </CardContent>
      </JoinOrgShell>
    )
  }

  // Signed in with a valid session → confirm + accept.
  if (hasValidSession) {
    return (
      <JoinOrgShell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-5" />{" "}
            {preview?.orgName ? `Join ${preview.orgName}` : "Join organization"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {previewSummary}
          <Button
            onClick={() => session?.jwt && void accept(session.jwt)}
            disabled={phase === "redeeming"}
          >
            {phase === "redeeming" ? "Joining…" : "Accept invitation"}
          </Button>
        </CardContent>
      </JoinOrgShell>
    )
  }

  // Signed out → inline auth. The session hook updates reactively on success,
  // which re-renders into the confirm card above.
  return (
    <JoinOrgShell>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-5" />{" "}
          {preview?.orgName ? `Join ${preview.orgName}` : "Join organization"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {previewSummary}
        <p className="text-sm text-muted-foreground">
          {authMode === "login"
            ? "Sign in to accept your invitation."
            : "Create an account to accept your invitation."}
        </p>
        {authMode === "login" ? (
          <FrontierLoginForm onSuccess={() => {}} />
        ) : (
          <FrontierSignupForm onSuccess={() => {}} />
        )}
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setAuthMode((m) => (m === "login" ? "signup" : "login"))}
        >
          {authMode === "login"
            ? "Need an account? Sign up"
            : "Already have an account? Sign in"}
        </button>
      </CardContent>
    </JoinOrgShell>
  )
}
