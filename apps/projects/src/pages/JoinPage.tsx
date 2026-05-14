// Invite-acceptance landing — `/projects/join/:token`.
//
// Mirrors src/components/JoinPage.tsx in the workspace SPA. Phase 3c port:
// previews the invite (no JWT needed for the preview endpoint), then either
// bounces to /login/?return=<here> if the user isn't signed in, or accepts
// the invite and hard-navigates to /w/:projectId.

import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  previewServerInvite,
  acceptServerInvite,
  type ServerInvitePreview,
} from "@aquilla/api-client"
import { getJwt } from "@aquilla/auth-client"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@aquilla/ui"

export function JoinPage() {
  const { token } = useParams<{ token: string }>()
  const [preview, setPreview] = useState<ServerInvitePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    previewServerInvite(token)
      .then((p) => {
        if (!cancelled) {
          if (!p) setError("Invite no longer valid.")
          else setPreview(p)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  async function handleAccept() {
    if (!token) return
    const jwt = getJwt()
    if (!jwt) {
      // Bounce to login, return here after sign-in.
      const here = window.location.href
      window.location.assign(`/login/?return=${encodeURIComponent(here)}`)
      return
    }
    setAccepting(true)
    setError(null)
    const result = await acceptServerInvite(jwt, token)
    setAccepting(false)
    if (!result) {
      setError("Couldn't accept this invite. It may have expired.")
      return
    }
    // Open the project workspace per AD-11 cross-app navigation.
    window.location.assign(`/w/${encodeURIComponent(result.projectId)}`)
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Join a project</h1>

      {loading && <p className="mt-4 text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <div className="mt-4 rounded border bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {preview && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{preview.projectName}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              You&rsquo;re invited as <strong>{preview.role.name}</strong>.
            </p>
            {preview.email && (
              <p className="text-xs text-muted-foreground">
                Invited as {preview.email}
              </p>
            )}
            <div className="pt-2">
              <Button disabled={accepting} onClick={handleAccept}>
                {accepting ? "Accepting…" : "Accept invite"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mt-6">
        <Link to="/">
          <Button variant="ghost" size="sm">
            ← All projects
          </Button>
        </Link>
      </div>
    </div>
  )
}
