import { useEffect, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { Loader2, AlertCircle, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  acceptServerInvite,
  previewServerInvite,
  type ServerInvitePreview,
} from "@/lib/sync/invites"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { FrontierSignupForm } from "@/components/git-import/FrontierSignupForm"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"

type Phase = "initial" | "redeeming" | "error"
type AuthMode = "login" | "signup" | "forgot"

/**
 * Share-link landing page. The token in the URL identifies a server-side
 * project_invites row; redeeming it adds the caller to project_members at
 * the role the inviter chose. After redemption, the workspace's normal
 * sync-token + sync-worker stack takes over — no separate bootstrap dance.
 *
 * Anonymous joining is intentionally not supported: server-side membership
 * is the only thing that unlocks /sync-token for this project, so the user
 * must be signed in.
 */
export function JoinPage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { session, loading: sessionLoading } = useFrontierSession()
  const [phase, setPhase] = useState<Phase>("initial")
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ServerInvitePreview | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>("login")

  // Fetch invite preview (public endpoint) so we can show project + role
  // context before the recipient authenticates.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    void previewServerInvite(token).then((p) => {
      if (!cancelled) setPreview(p)
    })
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    if (!token) {
      setPhase("error")
      setError("Invalid invite link")
      return
    }
    if (sessionLoading) return
    if (!session?.jwt) {
      // Stay on the preview card. The user clicks "Sign in" to continue.
      setPhase("initial")
      return
    }
    // Logged in: redeem immediately.
    void redeem(session.jwt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, session?.jwt, sessionLoading])

  async function redeem(jwt: string) {
    if (!token) return
    setPhase("redeeming")
    setError(null)
    const result = await acceptServerInvite(jwt, token)
    if (!result) {
      setPhase("error")
      setError(
        "This invite link is no longer valid. Ask the project owner for a fresh link."
      )
      return
    }
    navigate(`/project/${result.projectId}`)
  }

  const isSignedOut = !sessionLoading && !session?.jwt
  const showPreviewCard = isSignedOut && phase === "initial"

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Users className="h-5 w-5" />
            {showPreviewCard ? "You're invited" : "Joining Project"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {showPreviewCard ? (
            <div className="space-y-3">
              {preview ? (
                <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
                  <p className="text-sm">
                    Project:{" "}
                    <strong className="font-medium">{preview.projectName}</strong>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    You'll join as{" "}
                    <span className="capitalize">
                      {preview.role.name.replace(/_/g, " ")}
                    </span>
                    {preview.email && (
                      <>
                        {" "}— invitation sent to{" "}
                        <span className="font-mono">{preview.email}</span>
                      </>
                    )}
                    .
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Loading invitation details…
                </p>
              )}
              {/* Inline auth — on success the session updates and the redeem
                  effect above fires automatically, so the user never leaves. */}
              <div className="rounded-md border p-3">
                {authMode === "login" && (
                  <div className="space-y-3">
                    <FrontierLoginForm
                      onSuccess={() => {}}
                      onForgotPassword={() => setAuthMode("forgot")}
                    />
                    <p className="text-center text-xs text-muted-foreground">
                      New here?{" "}
                      <button
                        type="button"
                        onClick={() => setAuthMode("signup")}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        Create an account
                      </button>
                    </p>
                  </div>
                )}
                {authMode === "signup" && (
                  <div className="space-y-3">
                    <FrontierSignupForm onSuccess={() => {}} />
                    <p className="text-center text-xs text-muted-foreground">
                      Already have an account?{" "}
                      <button
                        type="button"
                        onClick={() => setAuthMode("login")}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        Log in
                      </button>
                    </p>
                  </div>
                )}
                {authMode === "forgot" && (
                  <FrontierForgotPasswordForm onBack={() => setAuthMode("login")} />
                )}
              </div>
              <p className="text-[10px] text-muted-foreground text-center">
                You'll join the moment you sign in — no need to come back.
              </p>
            </div>
          ) : phase === "redeeming" ? (
            <div className="flex flex-col items-center gap-2 py-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Joining project…</p>
            </div>
          ) : phase === "error" ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                <p className="text-sm">{error}</p>
              </div>
              <Button variant="outline" onClick={() => navigate("/")} className="w-full">
                Back to projects
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Initializing…</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
