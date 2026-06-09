import { useState } from "react"
import { Copy, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { createServerInvite } from "@/lib/sync/invites"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { MembersPanel, type MembersPanelMember } from "./MembersPanel"
import {
  ROLE,
  LINK_ROLE_OPTIONS,
  PROJECT_ROLE_OPTIONS,
} from "@/lib/frontier/roles"

interface SharePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** Fires after a server invite is successfully minted so the parent can
   * refresh any "you have outstanding shares" UI (onboarding checklist). */
  onSharesChanged?: () => void
}

// Roles visible in the share-link UI come from LINK_ROLE_OPTIONS (capped at
// contributor by ../lib/frontier/roles). Roles in the per-project Members tab
// come from PROJECT_ROLE_OPTIONS. Both are mirrored server-side; the
// server is the security boundary, this picker is the UX hint.
const DEFAULT_INVITE_ROLE = ROLE.CONTRIBUTOR

type Tab = "members" | "link"

export function SharePanel({ open, onOpenChange, projectId, onSharesChanged }: SharePanelProps) {
  const [tab, setTab] = useState<Tab>("members")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col overflow-hidden">
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

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "members" ? (
            <MembersTab projectId={projectId} />
          ) : (
            <InviteLinkTab
              projectId={projectId}
              onSharesChanged={onSharesChanged}
            />
          )}
        </div>
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
  projectId: string
  onSharesChanged?: () => void
}

/**
 * Mints a server-side project_invites row and shows the joinable URL once.
 * We deliberately don't list "your active invites" — that would need a
 * dedicated per-project listing endpoint, and revocation already lives in
 * the Members tab (each redemption becomes a project_members row the
 * inviter can demote/remove). Anyone with the link can redeem until it
 * expires or a member with sufficient role revokes it server-side.
 */
/** Expiry options: days (number) or null = no expiry. */
const EXPIRY_OPTIONS: { label: string; value: number | null }[] = [
  { label: "1 day", value: 1 },
  { label: "7 days (default)", value: 7 },
  { label: "30 days", value: 30 },
  { label: "No expiry", value: null },
]
const DEFAULT_EXPIRY_DAYS = 7

function InviteLinkTab({ projectId, onSharesChanged }: InviteLinkTabProps) {
  const { session } = useFrontierSession()
  const [inviteRole, setInviteRole] = useState<number>(DEFAULT_INVITE_ROLE)
  const [inviteEmail, setInviteEmail] = useState<string>("")
  const [emailError, setEmailError] = useState<string | null>(null)
  const [expiresInDays, setExpiresInDays] = useState<number | null>(DEFAULT_EXPIRY_DAYS)
  const [busy, setBusy] = useState(false)
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  async function handleCreate() {
    setEmailError(null)
    setServerError(null)
    setIssuedUrl(null)
    const trimmedEmail = inviteEmail.trim()
    if (trimmedEmail.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setEmailError("Enter a valid email address, or leave blank for an open link.")
      return
    }
    if (!session?.jwt) {
      setServerError("Sign in to create an invite link.")
      return
    }
    setBusy(true)
    try {
      const serverInvite = await createServerInvite(
        session.jwt,
        projectId,
        inviteRole,
        undefined,
        trimmedEmail || undefined,
        expiresInDays
      )
      if (!serverInvite) {
        setServerError("Couldn't create invite. You may not have permission, or the server is unreachable.")
        return
      }
      const url = `${window.location.origin}/join/${serverInvite.token}`
      setIssuedUrl(url)
      onSharesChanged?.()
    } finally {
      setBusy(false)
    }
  }

  function copyUrl(url: string) {
    void navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function reset() {
    setIssuedUrl(null)
    setCopied(false)
    setInviteEmail("")
    setInviteRole(DEFAULT_INVITE_ROLE)
    setExpiresInDays(DEFAULT_EXPIRY_DAYS)
  }

  if (issuedUrl) {
    return (
      <div className="space-y-3">
        <p className="text-sm">Invite link ready. Send it to the recipient.</p>
        <div className="flex items-center gap-1">
          <Input value={issuedUrl} readOnly className="text-xs font-mono" />
          <Button size="sm" variant="ghost" onClick={() => copyUrl(issuedUrl)} title="Copy URL">
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
        {copied && <p className="text-xs text-green-600">Copied!</p>}
        <p className="text-[10px] text-muted-foreground">
          The recipient signs in (or signs up) and is added as{" "}
          {LINK_ROLE_OPTIONS.find((o) => o.level === inviteRole)?.name ?? "a member"}.
          To revoke later, demote or remove them from the Members tab.
        </p>
        <Button size="sm" variant="outline" onClick={reset} className="w-full">
          Create another link
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
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
            : "Sign in to create an invite link"}
        </p>
      </div>
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
              : "Leave blank for an open link anyone signed in can redeem."}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Link expires</Label>
        <select
          className="w-full rounded border bg-background px-2 py-1 text-sm"
          value={expiresInDays === null ? "null" : String(expiresInDays)}
          onChange={(e) =>
            setExpiresInDays(e.target.value === "null" ? null : Number(e.target.value))
          }
          disabled={!session?.jwt}
        >
          {EXPIRY_OPTIONS.map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {serverError && (
        <p className="flex items-start gap-1 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{serverError}</span>
        </p>
      )}
      <Button
        size="sm"
        onClick={handleCreate}
        disabled={busy || !session?.jwt}
        className="w-full"
      >
        {busy ? "Creating…" : "Create invite link"}
      </Button>
    </div>
  )
}
