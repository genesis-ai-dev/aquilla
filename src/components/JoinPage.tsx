import { useEffect, useState } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { Loader2, KeyRound, AlertCircle, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { joinViaBootstrap, completeJoin } from "@/lib/sync/bootstrap"
import { getShare, hashPin } from "@/lib/sync/share-tokens"
import { acceptServerInvite } from "@/lib/sync/invites"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { ShareInvite } from "@/lib/parsers/types"

type Phase = "initial" | "discovering" | "pin-required" | "syncing" | "error"

export function JoinPage() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { session } = useFrontierSession()
  const [phase, setPhase] = useState<Phase>("initial")
  const [status, setStatus] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pin, setPin] = useState("")
  const [progress, setProgress] = useState({ synced: 0, total: 0 })
  const [localInvite, setLocalInvite] = useState<ShareInvite | null>(null)
  // State used by attemptJoin but not read in JSX
  const [, setRequiresPinUI] = useState(false)

  useEffect(() => {
    if (!token) {
      setPhase("error")
      setError("Invalid invite link")
      return
    }

    ;(async () => {
      // Check if we already have this share locally (we might be the owner or a returning peer)
      const existing = await getShare(token)
      setLocalInvite(existing || null)

      if (existing?.pinHash) {
        // We have the PIN requirement cached. We need the user's PIN entry.
        setRequiresPinUI(true)
        setPhase("pin-required")
      } else {
        // Either no PIN required, or we haven't joined before — try without PIN first
        attemptJoin(undefined)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function attemptJoin(pinValue: string | undefined) {
    if (!token) return
    setPhase("discovering")
    setError(null)
    setStatus("Connecting to collaborators...")

    try {
      const pinHashValue = pinValue ? await hashPin(pinValue, token) : undefined

      const payload = await joinViaBootstrap(token, pinHashValue, (s) => setStatus(s))

      const invite: ShareInvite = localInvite || {
        token,
        projectId: payload.projectRecord.id,
        pinHash: pinHashValue,
        createdAt: new Date().toISOString(),
        createdBy: "unknown",
      }

      setPhase("syncing")
      setStatus("Downloading project content...")

      const projectId = await completeJoin(invite, payload, (synced, total) => {
        setProgress({ synced, total })
      })

      // Redeem the server-side invite so /sync-token returns a real token
      // for this project. No-op when the joiner isn't logged in with
      // Frontier — they'll still see the project locally but multi-device
      // sync won't light up until they sign in and re-accept.
      if (session?.jwt) {
        await acceptServerInvite(session.jwt, token)
      }

      navigate(`/project/${projectId}`)
    } catch (err) {
      setPhase("error")
      setError(err instanceof Error ? err.message : "Failed to join")
    }
  }

  function handlePinSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (pin.length !== 6) return
    attemptJoin(pin)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Users className="h-5 w-5" /> Join Project
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {phase === "discovering" || phase === "syncing" ? (
            <div className="flex flex-col items-center gap-2 py-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">{status}</p>
              {phase === "syncing" && progress.total > 0 && (
                <p className="text-xs text-muted-foreground">
                  {progress.synced}/{progress.total} files synced
                </p>
              )}
            </div>
          ) : phase === "pin-required" ? (
            <form onSubmit={handlePinSubmit} className="space-y-3">
              <div className="flex flex-col items-center gap-2">
                <KeyRound className="h-8 w-8 text-primary" />
                <p className="text-sm text-center">This project requires a PIN</p>
              </div>
              <Input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                placeholder="000000"
                className="text-center text-lg font-mono tracking-widest"
                maxLength={6}
                autoFocus
              />
              <Button type="submit" disabled={pin.length !== 6} className="w-full">
                Join
              </Button>
            </form>
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
            <p className="text-sm text-muted-foreground">Initializing...</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
