import { useEffect, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { AlertCircle, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
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
import { isJwtExpired } from "@/lib/frontier/auth"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { FrontierSignupForm } from "@/components/git-import/FrontierSignupForm"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"
import posthog from "@/lib/posthog"
import { INVITE_REDEEMED } from "@/lib/event-names"
import { RoleLabel } from "@/components/RoleLabel"

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
  // The session JWT rides along (and the effect re-runs once the session
  // loads) so the server can recognize the original redeemer and return the
  // friendly usedByCaller preview instead of 410 used (AQU-347).
  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      const multiResult = await previewMultiInvite(token, undefined, session?.jwt ?? null)
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
  }, [token, session?.jwt])

  useEffect(() => {
    if (!token) {
      setPhase("error")
      setError("Invalid invite link")
    }
    // Signed-in users land on the confirmation card and accept explicitly
    // (AQU-335: silent auto-accept on link-open meant no user-facing signal
    // that access was just granted — and contradicted the join-via-invite-link
    // spec's confirmation step). Signed-out users see the same preview with
    // inline auth; after signing in they land on the confirmation too.
  }, [token])

  async function redeem(jwt: string) {
    if (!token) return
    setPhase("redeeming")
    setError(null)
    // Prefer the multi-project accept — it also redeems a single-project token
    // (one row) — then fall back to the legacy single-project accept.
    const multi = await acceptMultiInvite(jwt, token)
    if (multi.ok && multi.data.accepted.length > 0) {
      posthog.capture(INVITE_REDEEMED, {
        invite_kind: "multi",
        project_count: multi.data.accepted.length,
        project_id: multi.data.accepted[0].projectId,
      })
      navigate(`/project/${multi.data.accepted[0].projectId}`)
      return
    }
    const single = await acceptServerInvite(jwt, token)
    if (single.ok) {
      posthog.capture(INVITE_REDEEMED, {
        invite_kind: "single",
        project_count: 1,
        project_id: single.data.projectId,
      })
      navigate(`/project/${single.data.projectId}`)
      return
    }

    // Both accepts failed. AQU-364: an expired-JWT stored session used to
    // land here as "invite invalid" — extended to ANY 401/network failure,
    // since neither is evidence the invite itself is dead. Only a
    // definitive server verdict (410 used/expired, 404 unknown token, 403
    // wrong email) should render the "ask for a fresh link" error.
    //
    // isJwtExpired(jwt) covers a stored JWT that was already stale before
    // this call; single.reason === "unauthorized" additionally covers a JWT
    // that LOOKED valid client-side (unexpired `exp`) but the server still
    // rejected — e.g. a session that only just finished signing up. Both
    // re-prompt sign-in instead of showing a dead-invite error.
    if (isJwtExpired(jwt) || single.reason === "unauthorized") {
      setPhase("initial")
      return
    }
    if (single.reason === "network") {
      setPhase("error")
      setError("Couldn't reach the server. Check your connection and try again.")
      return
    }
    if (single.reason === "wrong_email") {
      setPhase("error")
      setError("This invite was sent to a different email address.")
      return
    }
    setPhase("error")
    setError(
      "This invite link is no longer valid. Ask the project owner for a fresh link."
    )
  }

  // An expired stored JWT is treated as signed-out: the accept endpoint would
  // 401 on it, so we re-prompt login (preserving this /join URL) rather than
  // letting the user click Accept and hit a misleading "invite invalid" error.
  const sessionExpired = !!session?.jwt && isJwtExpired(session.jwt)
  const hasValidSession = !!session?.jwt && !sessionExpired
  const isSignedOut = !sessionLoading && !hasValidSession
  const showPreviewCard = isSignedOut && phase === "initial"
  // AQU-335: signed-in users confirm explicitly instead of auto-accepting.
  const showConfirmCard = !sessionLoading && hasValidSession && phase === "initial"
  // Preview failed — show error instead of auth form / accept button. A
  // network failure only blocks the signed-out card (signed-in users can
  // still accept; the accept endpoint is the authority on token validity).
  const previewFailed =
    (showPreviewCard && previewLoadState !== null) ||
    (showConfirmCard && previewLoadState !== null && previewLoadState !== "network")
  // Preview is still in flight (null state and no data yet).
  const previewLoading =
    (showPreviewCard || showConfirmCard) && preview === null && previewLoadState === null

  // AQU-338: an email-bound single-project invite carries the recipient email
  // in its preview — prefill the cold-signup form with it. An anyone-with-link
  // invite (no bound email, valid per AQU-283) leaves the field empty and shows
  // honest helper copy instead. Multi-project previews don't expose a bound
  // email today, so they fall into the anyone-with-link branch.
  const boundEmail = preview?.kind === "single" ? preview.data.email : null

  // Invite summary — shared by the signed-out (auth) and signed-in (confirm)
  // branches. Single- and multi-project tokens both render through the one
  // InviteSummary component so the singular/plural copy stays correct (a
  // single-project token actually arrives via the multi endpoint — see the
  // preview effect above — so the "kind: multi, length 1" case is the common
  // real-world path and must not say "each"; AQU-337).
  const previewSummary =
    preview?.kind === "single" ? (
      <InviteSummary
        projects={[
          {
            projectId: preview.data.projectId,
            projectName: preview.data.projectName,
          },
        ]}
        roleName={preview.data.role.name}
        email={preview.data.email}
      />
    ) : preview?.kind === "multi" ? (
      <InviteSummary
        projects={preview.data.projects}
        roleName={preview.data.role.name}
      />
    ) : previewLoading ? (
      <div className="flex items-center gap-2 py-1">
        <Spinner className="text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Loading invitation details…
        </p>
      </div>
    ) : null

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Users className="h-5 w-5" />
            {(showPreviewCard || showConfirmCard) && !previewFailed
              ? "You're invited"
              : "Joining Project"}
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
                  ) : previewLoadState === "used" ? (
                    <>
                      <p className="text-sm font-medium">This link has already been used</p>
                      <p className="text-xs text-muted-foreground">
                        This invite link is single-use and has already been redeemed.
                        Ask the project owner to send you a new invite link.
                      </p>
                    </>
                  ) : previewLoadState === "time_expired" ? (
                    <>
                      <p className="text-sm font-medium">This link has expired</p>
                      <p className="text-xs text-muted-foreground">
                        This invite link is no longer valid because it has passed its
                        expiry date. Ask the project owner for a new invite link.
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
          ) : showConfirmCard ? (
            // AQU-335: explicit accept step (spec join-via-invite-link Step 2:
            // "Token valid, recipient already signed in → JoinPage shows
            // confirmation"). Access is granted only on the button click, so
            // gaining membership is always a visible, deliberate action.
            <div className="space-y-3">
              {previewSummary}
              <Button
                className="w-full"
                onClick={() => session?.jwt && void redeem(session.jwt)}
                disabled={previewLoading}
              >
                Accept invitation
              </Button>
              <Button variant="outline" onClick={() => navigate("/")} className="w-full">
                Not now
              </Button>
            </div>
          ) : showPreviewCard ? (
            <div className="space-y-3">
              {previewSummary}
              {/* Expired session: tell the user why they're seeing login again
                  so an expired JWT doesn't read as a broken invite link. */}
              {sessionExpired && (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  Your session expired — sign in again to join. Your invitation
                  is still valid.
                </p>
              )}
              {/* Inline auth — on success the session updates and the page
                  swaps to the confirmation card so the user accepts explicitly. */}
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
                    {/* AQU-338: be honest about what the email field means —
                        prefilled-and-changeable for a bound invite, or
                        free-form for an anyone-with-link invite. Gated on the
                        preview so we never assert "unbound" while it loads. */}
                    {preview && (
                      <p className="text-xs text-muted-foreground">
                        {boundEmail
                          ? "We've pre-filled the email from your invitation — you can use a different one if you prefer."
                          : "This invite isn't bound to an email — sign up with any email you'd like."}
                      </p>
                    )}
                    <FrontierSignupForm onSuccess={() => {}} initialEmail={boundEmail} />
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
                After you sign in, you'll confirm and join — no need to come back.
              </p>
            </div>
          ) : phase === "redeeming" ? (
            <div className="flex flex-col items-center gap-2 py-4">
              <Spinner className="size-8 text-primary" />
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

/** One project row in the invite summary. `projectName` is preferred for
 * display; `projectId` is only a fallback so a nameless row never shows blank
 * (AQU-337 acceptance: show the project name, not the opaque id). */
export interface InviteSummaryProject {
  projectId: string
  projectName: string
  archived?: boolean
}

/**
 * Invite-summary card body, shared by the single- and multi-project preview
 * branches. Pluralization is driven purely by how many projects the token
 * grants:
 *
 * - Exactly one project → "You'll join as {role}." (no "each"), with the
 *   project named inline. This is the case the cold-signup walkthrough hit
 *   (AQU-337): a single-project token that arrives through the multi endpoint
 *   used to render "You'll join each as …", which is wrong for one invitee /
 *   one project.
 * - More than one project → the bulleted project list plus "You'll join each
 *   as {role}." — here "each" correctly distributes the role over the list.
 *
 * The multi-invite payload carries a single `role` for the whole token (there
 * is no per-project role in the preview data model), so the role line is
 * shared across all rows by design.
 */
export function InviteSummary({
  projects,
  roleName,
  email,
}: {
  projects: InviteSummaryProject[]
  roleName: string
  email?: string | null
}) {
  const role = <RoleLabel name={roleName} />
  const emailSuffix = email ? (
    <>
      {" "}— invitation sent to <span className="font-mono">{email}</span>
    </>
  ) : null

  if (projects.length === 1) {
    const p = projects[0]
    return (
      <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
        <p className="text-sm">
          Project:{" "}
          <strong className="font-medium">
            {p.projectName || p.projectId}
            {p.archived ? " (archived)" : ""}
          </strong>
        </p>
        <p className="text-xs text-muted-foreground">
          You'll join as {role}
          {emailSuffix}.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
      <p className="text-sm">
        You're invited to{" "}
        <strong className="font-medium">{projects.length} projects</strong>:
      </p>
      <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
        {projects.map((p) => (
          <li key={p.projectId}>
            {p.projectName || p.projectId}
            {p.archived ? " (archived)" : ""}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        You'll join each as {role}
        {emailSuffix}.
      </p>
    </div>
  )
}
