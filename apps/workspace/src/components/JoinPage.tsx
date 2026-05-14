import { useEffect, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { Loader2, AlertCircle, Users, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  acceptServerInvite,
  previewServerInvite,
  type ServerInvitePreview,
} from "@/lib/sync/invites"
import { useFrontierSession } from "@/hooks/useFrontierSession"

/**
 * Where to send the user back after they sign in. Saved to localStorage so
 * the auth surface (which lives outside this route) can pick it up.
 */
const POST_LOGIN_REDIRECT_KEY = "postLoginRedirect"

type Phase = "initial" | "redeeming" | "error"

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

  // Stash the post-login redirect so the auth surface returns the user here.
  function rememberRedirectAndGoToLogin() {
    if (!token) return
    try {
      localStorage.setItem(POST_LOGIN_REDIRECT_KEY, `/join/${token}`)
    } catch {
      // Private mode / quota / etc — non-fatal; user will land on dashboard
      // after login and can re-paste the invite URL.
    }
    navigate("/")
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
              <Button
                onClick={rememberRedirectAndGoToLogin}
                className="w-full"
              >
                <LogIn className="mr-1.5 h-4 w-4" />
                Sign in or sign up to continue
              </Button>
              <p className="text-[10px] text-muted-foreground text-center">
                After you sign in, you'll come back here automatically.
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
