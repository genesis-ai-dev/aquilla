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
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { MembersPanel, type MembersPanelMember } from "./MembersPanel"
import {
  ROLE,
  LINK_ROLE_OPTIONS,
  PROJECT_ROLE_OPTIONS,
} from "@/lib/frontier/roles"
import type { ShareInvite } from "@/lib/parsers/types"

interface SharePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  username: string
  onSharesChanged?: () => void
}

// Roles visible in the share-link UI come from LINK_ROLE_OPTIONS (capped at
// contributor by ../lib/frontier/roles). Roles in the per-project Members tab
// come from PROJECT_ROLE_OPTIONS. Both are mirrored server-side; the
// server is the security boundary, this picker is the UX hint.
const DEFAULT_INVITE_ROLE = ROLE.CONTRIBUTOR

type Tab = "members" | "link"

export function SharePanel({ open, onOpenChange, projectId, username, onSharesChanged }: SharePanelProps) {
  const [tab, setTab] = useState<Tab>("members")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share Project</DialogTitle>
        </DialogHeader>

        <div className="mb-3 flex gap-2 border-b">
          <button
            type="button"
            onClick={() => setTab("members")}
            className={`px-3 py-1.5 text-sm ${
              tab === "members"
                ? "border-b-2 border-primary font-medium"
                : "text-muted-foreground"
            }`}
          >
            Members
          </button>
          <button
            type="button"
            onClick={() => setTab("link")}
            className={`px-3 py-1.5 text-sm ${
              tab === "link"
                ? "border-b-2 border-primary font-medium"
                : "text-muted-foreground"
            }`}
          >
            Invite link
          </button>
        </div>

        {tab === "members" ? (
          <MembersTab projectId={projectId} />
        ) : (
          <InviteLinkTab
            open={open}
            projectId={projectId}
            username={username}
            onSharesChanged={onSharesChanged}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MembersTab({ projectId }: { projectId: string }) {
  // FrontierSession has no userId — server enforces self-grant rejection so we
  // pass null and skip the local self-block.
  const callerUserId = null
  const callerMaxRole = ROLE.MAINTAINER // Server caps grants; we permit the full grantable range.

  const { members, isLoading, error, add, remove } = useProjectMembers(projectId)

  const panelMembers: MembersPanelMember[] = members.map((m) => ({
    userId: m.userId,
    username: m.username,
    roleLevel: m.role.level,
    roleName: m.role.name,
    source: m.role.source,
    isLocked: m.role.source === "org" || m.role.source === "creator",
    lockedHint:
      m.role.source === "org"
        ? "Remove from org to revoke"
        : m.role.source === "creator"
          ? "Project creator"
          : undefined,
  }))

  return (
    <div>
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      {isLoading && members.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <MembersPanel
          members={panelMembers}
          roleOptions={[...PROJECT_ROLE_OPTIONS]}
          defaultRole={ROLE.CONTRIBUTOR}
          callerUserId={callerUserId}
          callerMaxRole={callerMaxRole}
          onAdd={async (username, role) => {
            const result = await add(username, role)
            return result ? { ok: true } : { ok: false, error: "No user with that username" }
          }}
          onRemove={remove}
          onChangeRole={async (username, role) => { await add(username, role) }}
        />
      )}
    </div>
  )
}

interface InviteLinkTabProps {
  open: boolean
  projectId: string
  username: string
  onSharesChanged?: () => void
}

function InviteLinkTab({ open, projectId, username, onSharesChanged }: InviteLinkTabProps) {
  const [shares, setShares] = useState<ShareInvite[]>([])
  const [newShareForm, setNewShareForm] = useState(false)
  const [requirePin, setRequirePin] = useState(false)
  const [generatedPin, setGeneratedPin] = useState("")
  const [revealedPins, setRevealedPins] = useState<Set<string>>(new Set())
  const [pinCache, setPinCache] = useState<Map<string, string>>(new Map())
  const [copied, setCopied] = useState<string | null>(null)
  const [inviteRole, setInviteRole] = useState<number>(DEFAULT_INVITE_ROLE)
  // Optional email binding. When set, the server stores the email on the
  // invite row and the JoinPage prefills the sign-up form for unsigned-up
  // recipients. The token is still the credential (Zoom-URL semantics);
  // the email is purely UX prefill + audit trail.
  const [inviteEmail, setInviteEmail] = useState<string>("")
  const [emailError, setEmailError] = useState<string | null>(null)

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
    setEmailError(null)
    const trimmedEmail = inviteEmail.trim()
    // Light client-side validation — server does the canonical check via
    // zod's email refinement, but we want to fail fast in the UI before
    // the round-trip.
    if (trimmedEmail.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setEmailError("Enter a valid email address, or leave blank for an open link.")
      return
    }
    const pin = requirePin ? generatedPin : undefined
    // Register server-side first so the local ShareInvite and the server's
    // project_invites row share one token. Falls back to a local-only token
    // when there's no active Frontier session — the joiner can still receive
    // the project record, but without server-side membership /sync-token
    // will 403 and multi-device sync won't light up for them.
    const serverInvite = session?.jwt
      ? await createServerInvite(
          session.jwt,
          projectId,
          inviteRole,
          undefined,
          trimmedEmail || undefined
        )
      : null
    const invite = await createShare(projectId, pin, username, serverInvite?.token)
    if (pin) {
      setPinCache((p) => new Map(p).set(invite.token, pin))
    }
    setNewShareForm(false)
    setRequirePin(false)
    setGeneratedPin("")
    setInviteRole(DEFAULT_INVITE_ROLE)
    setInviteEmail("")
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
              {LINK_ROLE_OPTIONS.map((opt) => (
                <option key={opt.level} value={opt.level}>
                  {opt.name}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground">
              {session?.jwt
                ? LINK_ROLE_OPTIONS.find((o) => o.level === inviteRole)?.description
                : "Sign in to pick a role — local-only share creates a read-write link"}
            </p>
          </div>
          {/* Optional email recipient — turns this from an "anyone with the
              link" share into a targeted invite with sign-up prefill. */}
          <div className="space-y-1">
            <Label htmlFor="invite-email" className="text-xs">
              Recipient email <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="invite-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={inviteEmail}
              onChange={(e) => {
                setInviteEmail(e.target.value)
                setEmailError(null)
              }}
              placeholder="name@example.com"
              disabled={!session?.jwt}
            />
            {emailError ? (
              <p className="text-[10px] text-destructive">{emailError}</p>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                {inviteEmail.trim()
                  ? "If they don't have a Frontier account, the join page prefills sign-up with this email."
                  : "Leave blank for an open link anyone can redeem."}
              </p>
            )}
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
  )
}
