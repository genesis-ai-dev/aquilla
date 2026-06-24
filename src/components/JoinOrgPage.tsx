import { useState, type ReactNode } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { AlertCircle, Users, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { acceptOrgInvite } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { isJwtExpired } from "@/lib/frontier/auth"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { FrontierSignupForm } from "@/components/git-import/FrontierSignupForm"
import { UserError } from "@/lib/errors/user-error"
import posthog from "@/lib/posthog"
import { INVITE_REDEEMED } from "@/lib/analytics-events"

type Phase = "initial" | "redeeming" | "done" | "error"
type AuthMode = "login" | "signup"

/**
 * Organization invite landing page (/join-org/:token). The token identifies an
 * org_invites row; redeeming it adds the caller to org_members at the invited
 * role. Like the project JoinPage, membership requires a signed-in account, so
 * signed-out users get inline auth first. Unlike JoinPage there is no public
 * preview endpoint (the orgs router is fully authed), so we confirm + accept in
 * one step once the user has a valid session.
 */
export function JoinOrgPage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { session, loading: sessionLoading } = useFrontierSession()
  const [phase, setPhase] = useState<Phase>("initial")
  const [error, setError] = useState<string | null>(null)
  const [orgName, setOrgName] = useState<string | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>("login")

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
      setTimeout(() => navigate(`/?org=${result.orgId}`), 1200)
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

  function Shell({ children }: { children: ReactNode }) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">{children}</Card>
      </div>
    )
  }

  if (!token) {
    return (
      <Shell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="size-5 text-destructive" /> Invalid invite link
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => navigate("/")}>Go home</Button>
        </CardContent>
      </Shell>
    )
  }

  if (phase === "error") {
    return (
      <Shell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="size-5 text-destructive" /> Can't join
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={() => navigate("/")}>Go home</Button>
        </CardContent>
      </Shell>
    )
  }

  if (phase === "done") {
    return (
      <Shell>
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
      </Shell>
    )
  }

  if (sessionLoading) {
    return (
      <Shell>
        <CardContent className="flex items-center justify-center py-10">
          <Spinner className="mr-2" /> <span className="text-sm">Loading…</span>
        </CardContent>
      </Shell>
    )
  }

  // Signed in with a valid session → confirm + accept.
  if (hasValidSession) {
    return (
      <Shell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-5" /> Join organization
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            You've been invited to join an organization on Aquilla.
          </p>
          <Button
            onClick={() => session?.jwt && void accept(session.jwt)}
            disabled={phase === "redeeming"}
          >
            {phase === "redeeming" ? "Joining…" : "Accept invitation"}
          </Button>
        </CardContent>
      </Shell>
    )
  }

  // Signed out → inline auth. The session hook updates reactively on success,
  // which re-renders into the confirm card above.
  return (
    <Shell>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-5" /> Join organization
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
    </Shell>
  )
}
