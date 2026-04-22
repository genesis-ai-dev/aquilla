import { useEffect, useState, useCallback } from "react"
import { Copy, Eye, EyeOff, Trash2, RefreshCw, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  listShares, createShare, deleteShare, generatePin, updateSharePin,
} from "@/lib/sync/share-tokens"
import { createServerInvite } from "@/lib/sync/invites"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { ShareInvite } from "@/lib/parsers/types"

interface SharePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  username: string
  onSharesChanged?: () => void
}

// Roles visible in the share UI. Project_lead (500) and above can only be
// granted by maintainer-and-up and aren't useful in a "share with a
// collaborator" flow, so they're intentionally omitted.
const INVITE_ROLE_OPTIONS: Array<{ level: number; name: string; description: string }> = [
  { level: 100, name: "viewer", description: "Read-only access to cells + comments" },
  { level: 200, name: "commenter", description: "Read + add comments on cells" },
  { level: 300, name: "reviewer", description: "Read + comment + validate cells (no content edits)" },
  { level: 400, name: "contributor", description: "Read + comment + edit cell content" },
]
const DEFAULT_INVITE_ROLE = 400

export function SharePanel({ open, onOpenChange, projectId, username, onSharesChanged }: SharePanelProps) {
  const [shares, setShares] = useState<ShareInvite[]>([])
  const [newShareForm, setNewShareForm] = useState(false)
  const [requirePin, setRequirePin] = useState(false)
  const [generatedPin, setGeneratedPin] = useState("")
  const [revealedPins, setRevealedPins] = useState<Set<string>>(new Set())
  const [pinCache, setPinCache] = useState<Map<string, string>>(new Map())
  const [copied, setCopied] = useState<string | null>(null)
  const [inviteRole, setInviteRole] = useState<number>(DEFAULT_INVITE_ROLE)

  const refresh = useCallback(async () => {
    const list = await listShares(projectId)
    setShares(list)
    onSharesChanged?.()
  }, [projectId, onSharesChanged])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  useEffect(() => {
    if (requirePin && !generatedPin) {
      setGeneratedPin(generatePin())
    }
  }, [requirePin, generatedPin])

  const { session } = useFrontierSession()

  async function handleCreate() {
    const pin = requirePin ? generatedPin : undefined
    // Register server-side first so the local ShareInvite and the server's
    // project_invites row share one token. Falls back to a local-only token
    // when there's no active Frontier session — the joiner can still receive
    // the project record, but without server-side membership /sync-token
    // will 403 and multi-device sync won't light up for them.
    const serverInvite = session?.jwt
      ? await createServerInvite(session.jwt, projectId, inviteRole)
      : null
    const invite = await createShare(projectId, pin, username, serverInvite?.token)
    if (pin) {
      setPinCache((p) => new Map(p).set(invite.token, pin))
    }
    setNewShareForm(false)
    setRequirePin(false)
    setGeneratedPin("")
    setInviteRole(DEFAULT_INVITE_ROLE)
    await refresh()
  }

  async function handleDelete(token: string) {
    const ok = window.confirm("Delete this share link? Anyone with the link will no longer be able to join. (Peers who already joined will retain their local copy.)")
    if (!ok) return
    await deleteShare(token)
    await refresh()
  }

  async function handleRegeneratePin(token: string) {
    const newPin = generatePin()
    await updateSharePin(token, newPin)
    setPinCache((p) => new Map(p).set(token, newPin))
    setRevealedPins((p) => new Set(p).add(token))
    await refresh()
  }

  function togglePinReveal(token: string) {
    setRevealedPins((p) => {
      const next = new Set(p)
      if (next.has(token)) next.delete(token)
      else next.add(token)
      return next
    })
  }

  function copyUrl(token: string) {
    const url = `${window.location.origin}/join/${token}`
    navigator.clipboard.writeText(url)
    setCopied(token)
    setTimeout(() => setCopied(null), 1500)
  }

  function buildUrl(token: string): string {
    return `${window.location.origin}/join/${token}`
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share Project</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {shares.length === 0 && !newShareForm && (
            <p className="text-sm text-muted-foreground">
              No active share links. Create one to invite collaborators.
            </p>
          )}

          {shares.map((share) => {
            const cachedPin = pinCache.get(share.token)
            const revealed = revealedPins.has(share.token)
            return (
              <div key={share.token} className="rounded border p-2 space-y-1.5">
                <div className="flex items-center gap-1">
                  <Input value={buildUrl(share.token)} readOnly className="text-xs font-mono" />
                  <Button size="sm" variant="ghost" onClick={() => copyUrl(share.token)} title="Copy URL">
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {copied === share.token && <p className="text-xs text-green-600">Copied!</p>}

                {share.pinHash && (
                  <div className="flex items-center gap-1 text-xs">
                    <KeyRound className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">PIN:</span>
                    {cachedPin ? (
                      <>
                        <span className="font-mono">
                          {revealed ? cachedPin : "••••••"}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 w-5 p-0"
                          onClick={() => togglePinReveal(share.token)}
                        >
                          {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </Button>
                      </>
                    ) : (
                      <span className="text-muted-foreground italic">
                        (not cached - regenerate to see)
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 w-5 p-0"
                      onClick={() => handleRegeneratePin(share.token)}
                      title="Regenerate PIN"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  </div>
                )}

                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>Created by {share.createdBy}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(share.token)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            )
          })}

          {newShareForm ? (
            <div className="rounded border border-primary/50 p-3 space-y-2">
              <div className="space-y-1">
                <Label className="text-xs">Role</Label>
                <select
                  className="w-full rounded border bg-background px-2 py-1 text-sm"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(Number(e.target.value))}
                  disabled={!session?.jwt}
                >
                  {INVITE_ROLE_OPTIONS.map((opt) => (
                    <option key={opt.level} value={opt.level}>
                      {opt.name}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-muted-foreground">
                  {session?.jwt
                    ? INVITE_ROLE_OPTIONS.find((o) => o.level === inviteRole)?.description
                    : "Sign in to pick a role — local-only share creates a read-write link"}
                </p>
              </div>
              <Label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={requirePin}
                  onChange={(e) => setRequirePin(e.target.checked)}
                />
                Require PIN
              </Label>
              {requirePin && (
                <div className="flex items-center gap-1">
                  <Input
                    value={generatedPin}
                    onChange={(e) => setGeneratedPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                    className="font-mono tracking-widest"
                    maxLength={6}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setGeneratedPin(generatePin())}
                    title="Regenerate"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </Button>
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setNewShareForm(false)} className="flex-1">
                  Cancel
                </Button>
                <Button size="sm" onClick={handleCreate} className="flex-1" disabled={requirePin && generatedPin.length !== 6}>
                  Create
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setNewShareForm(true)}
              className="w-full"
            >
              + Create share link
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
