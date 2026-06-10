import { useEffect, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { Loader2, AlertCircle, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  acceptServerInvite,
  previewServerInvite,
  previewMultiInvite,
  acceptMultiInvite,
  type InvitePreviewFailReason,
  type ServerInvitePreview,
  type MultiInvitePreview,
} from "@/lib/sync/invites"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { FrontierSignupForm } from "@/components/git-import/FrontierSignupForm"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"
import posthog from "@/lib/posthog"
import { INVITE_REDEEMED } from "@/lib/analytics-events"

type Phase = "initial" | "redeeming" | "error"
type AuthMode = "login" | "signup" | "forgot"
/** A token may be a single-project invite or a multi-project one (N projects). */
type InvitePreview =
  | { kind: "single"; data: ServerInvitePreview }
  | { kind: "multi"; data: MultiInvitePreview }
/** null = still loading; InvitePreviewFailReason = failed */
type PreviewLoadState = null | InvitePreviewFailReason

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
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  // null = still loading; string = failed with that reason
  const [previewLoadState, setPreviewLoadState] = useState<PreviewLoadState>(null)
  const [authMode, setAuthMode] = useState<AuthMode>("login")

  // Fetch invite preview (public). Try the multi-project endpoint first — it
  // returns 1 project for a single-project token too — and fall back to the
  // single-project preview if the multi endpoint has nothing.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      const multiResult = await previewMultiInvite(token)
      if (cancelled) return
      if (multiResult.ok && multiResult.data.projects.length > 0) {
        setPreview({ kind: "multi", data: multiResult.data })
        setPreviewLoadState(null) // loaded ok — clear any prior error
        return
      }
      // Multi endpoint failed or returned empty — try single-project endpoint.
      // Propagate the multi failure reason only if it's definitive (expired/invalid),
      // otherwise try single and use its result.
      const singleResult = await previewServerInvite(token)
      if (cancelled) return
      if (singleResult.ok) {
        setPreview({ kind: "single", data: singleResult.data })
        setPreviewLoadState(null)
      } else {
        // Both endpoints failed. Prefer the multi failure reason if it's
        // expired/invalid (definitive); fall back to single's reason.
        const reason =
          !multiResult.ok && multiResult.reason !== "network"
            ? multiResult.reason
            : singleResult.reason
        setPreviewLoadState(reason)
      }
    })()
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
    // Prefer the multi-project accept — it also redeems a single-project token
    // (one row) — then fall back to the legacy single-project accept.
    const multi = await acceptMultiInvite(jwt, token)
    if (multi && multi.accepted.length > 0) {
      posthog.capture(INVITE_REDEEMED, {
        invite_kind: "multi",
        project_count: multi.accepted.length,
        project_id: multi.accepted[0].projectId,
      })
      navigate(`/project/${multi.accepted[0].projectId}`)
      return
    }
    const single = await acceptServerInvite(jwt, token)
    if (single) {
      posthog.capture(INVITE_REDEEMED, {
        invite_kind: "single",
        project_count: 1,
        project_id: single.projectId,
      })
      navigate(`/project/${single.projectId}`)
      return
    }
    setPhase("error")
    setError(
      "This invite link is no longer valid. Ask the project owner for a fresh link."
    )
  }

  const isSignedOut = !sessionLoading && !session?.jwt
  const showPreviewCard = isSignedOut && phase === "initial"
  // Preview failed while signed-out — show error instead of auth form.
  const previewFailed = showPreviewCard && previewLoadState !== null
  // Preview is still in flight (null state and no data yet).
  const previewLoading = showPreviewCard && preview === null && previewLoadState === null

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Users className="h-5 w-5" />
            {showPreviewCard && !previewFailed ? "You're invited" : "Joining Project"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Signed-out + preview failed: show recovery UI, no signup form */}
          {previewFailed ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-destructive">
                <AlertCircle className="h-5 w-5 mt-0.5 shrink-0" />
                <div className="space-y-1">
                  {previewLoadState === "network" ? (
                    <>
                      <p className="text-sm font-medium">Couldn't load invitation</p>
                      <p className="text-xs text-muted-foreground">
                        Check your connection and try again.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-medium">This invite link is no longer valid</p>
                      <p className="text-xs text-muted-foreground">
                        Ask the project owner for a new invite link.
                      </p>
                    </>
                  )}
                </div>
              </div>
              {previewLoadState === "network" ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    // Reset load state so the effect can re-run on token change,
                    // but since the token won't change we reload the page.
                    window.location.reload()
                  }}
                  className="w-full"
                >
                  Try again
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => navigate("/")} className="w-full">
                Back to projects
              </Button>
            </div>
          ) : showPreviewCard ? (
            <div className="space-y-3">
              {preview?.kind === "single" ? (
                <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
                  <p className="text-sm">
                    Project:{" "}
                    <strong className="font-medium">{preview.data.projectName}</strong>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    You'll join as{" "}
                    <span className="capitalize">
                      {preview.data.role.name.replace(/_/g, " ")}
                    </span>
                    {preview.data.email && (
                      <>
                        {" "}— invitation sent to{" "}
                        <span className="font-mono">{preview.data.email}</span>
                      </>
                    )}
                    .
                  </p>
                </div>
              ) : preview?.kind === "multi" ? (
                <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
                  <p className="text-sm">
                    You're invited to{" "}
                    <strong className="font-medium">
                      {preview.data.projects.length} project
                      {preview.data.projects.length === 1 ? "" : "s"}
                    </strong>
                    :
                  </p>
                  <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                    {preview.data.projects.map((p) => (
                      <li key={p.projectId}>
                        {p.projectName}
                        {p.archived ? " (archived)" : ""}
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted-foreground">
                    You'll join each as{" "}
                    <span className="capitalize">
                      {preview.data.role.name.replace(/_/g, " ")}
                    </span>
                    .
                  </p>
                </div>
              ) : previewLoading ? (
                <div className="flex items-center gap-2 py-1">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">
                    Loading invitation details…
                  </p>
                </div>
              ) : null}
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
