// AQU-180: Per-project members page (/project/:id/members).
//
// Renders inside the ProjectWorkspace shell (AQU-254 surface-swap pattern).
// Shell stays mounted; only the center content area swaps.
//
// Features:
//   - Effective member list (GET /projects/:id/members) incl. secondarySources
//   - Direct-grant add / change-role / remove (reuses useProjectMembers hook)
//   - Invite-link generation with expiry selector (reuses InviteLinkTab logic)
//   - "Revoke all access" with grant-path enumeration + typed confirmation

import { useState, useCallback } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  ArrowLeft, UserPlus, LinkIcon, ShieldOff, RefreshCcw,
  AlertTriangle, Copy, Lock, Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Input } from "@/components/ui/input"
import { FieldLabel } from "@/components/ui/field"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { PermissionDeniedAlert } from "@/components/PermissionDeniedAlert"
import {
  revokeAllProjectAccess, partitionMembers, type RevokeAllResult,
} from "@/lib/frontier/members"
import { createServerInvite } from "@/lib/sync/invites"
import {
  ROLE,
  LINK_ROLE_OPTIONS,
  PROJECT_ROLE_OPTIONS,
  roleDisplayText,
} from "@/lib/frontier/roles"
import { RoleLabel } from "@/components/RoleLabel"
import type { ProjectMember } from "@/lib/frontier/members"
import { toUserFacingError } from "@/lib/errors/user-error"

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_INVITE_ROLE = ROLE.CONTRIBUTOR
const EXPIRY_OPTIONS: { label: string; value: number | null }[] = [
  { label: "1 day", value: 1 },
  { label: "7 days (default)", value: 7 },
  { label: "30 days", value: 30 },
  { label: "No expiry", value: null },
]
const DEFAULT_EXPIRY_DAYS = 7

// ──────────────────────────────────────────────────────────────────────────
// Main surface
// ──────────────────────────────────────────────────────────────────────────

type ActiveTab = "members" | "invite"

export function ProjectMembersPage() {
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<ActiveTab>("members")

  if (!projectId) return null

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Back header */}
      <div className="flex items-center gap-3 border-b bg-background px-6 py-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          onClick={() => navigate(`/project/${projectId}`)}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to project
        </Button>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="h-4 w-4 text-muted-foreground" />
          Members
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-2 border-b px-6">
        <button
          type="button"
          onClick={() => setTab("members")}
          className={cn(
            "px-3 py-2 text-sm",
            tab === "members"
              ? "border-b-2 border-primary font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Members
        </button>
        <button
          type="button"
          onClick={() => setTab("invite")}
          className={cn(
            "px-3 py-2 text-sm",
            tab === "invite"
              ? "border-b-2 border-primary font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Invite link
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {tab === "members" ? (
          <MembersTab projectId={projectId} />
        ) : (
          <InviteLinkTab projectId={projectId} />
        )}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Members tab
//
// Exported (AQU-335) so the org-side ProjectOverview (/projects/:id) can
// embed the same members add/change-role/revoke surface the in-project
// members page offers — one implementation, two surfaces.
// ──────────────────────────────────────────────────────────────────────────

export function MembersTab({
  projectId,
  className = "mx-auto max-w-2xl space-y-6",
}: {
  projectId: string
  /** Layout wrapper classes; override when embedding outside the members page. */
  className?: string
}) {
  const { session } = useFrontierSession()
  const { members, isLoading, error, rosterHidden, refresh, add, remove } = useProjectMembers(projectId)
  const callerMaxRole = ROLE.MAINTAINER
  const callerUserId = null

  // Add form state
  const [newUsername, setNewUsername] = useState("")
  const [newRole, setNewRole] = useState<number>(ROLE.CONTRIBUTOR)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // AQU-560: when the add is refused for lack of permission, surface the
  // enriched account-identity + switch-user alert instead of the bare message
  // (the denial is usually "you're on the wrong account").
  const [addForbidden, setAddForbidden] = useState(false)

  // Revoke-all state
  const [revokeTarget, setRevokeTarget] = useState<ProjectMember | null>(null)

  const handleAdd = useCallback(async () => {
    const trimmed = newUsername.trim()
    if (!trimmed) return
    setAdding(true)
    setAddError(null)
    setAddForbidden(false)
    try {
      const result = await add(trimmed, newRole)
      if (!result) {
        setAddError("No user found with that username")
        return
      }
      setNewUsername("")
    } catch (e) {
      const uf = toUserFacingError(e, "project")
      setAddForbidden(uf.category === "forbidden")
      setAddError(uf.message)
    } finally {
      setAdding(false)
    }
  }, [add, newUsername, newRole])

  const grantableRoles = PROJECT_ROLE_OPTIONS.filter((r) => r.level <= callerMaxRole)

  // AQU-454: a project's roster should read as the project's team, not a copy
  // of the whole org. Org members inherit access to every project via AD-12
  // max-wins (04-features/members-and-sharing.md), so a large org floods each
  // project's member list. We still show everyone (spec: "view all members …
  // with a one-line summary of which paths contribute") but split the list so
  // people actually granted access to THIS project (direct / group / creator)
  // are distinct from those who only reach it through an org-wide role.
  const { projectMembers, orgAccessMembers } = partitionMembers(members)

  const renderMemberRow = (m: ProjectMember) => {
    const isSelf = callerUserId !== null && m.userId === callerUserId
    const isLocked = m.role.source === "org" || m.role.source === "creator"
    const lockedHint =
      m.role.source === "org"
        ? "Access via org membership — remove from org to revoke"
        : m.role.source === "creator"
          ? "Project creator"
          : undefined

    return (
      <li
        key={m.userId}
        className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm"
      >
        <span className="font-medium">{m.username}</span>
        <SourceBadge source={m.role.source} />
        <RoleLabel name={m.role.name} className="text-xs text-muted-foreground" />

        {/* Secondary sources */}
        {m.secondarySources && m.secondarySources.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            + {m.secondarySources.map((s) => `${s.source}:${s.name}`).join(", ")}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Role change dropdown — only for direct grants, not self */}
          {!isLocked && !isSelf && (
            <Select
              items={[
                // Current role may sit above the caller's grantable
                // cap; include it so the closed trigger renders the
                // role name instead of the raw level.
                ...(grantableRoles.some((r) => r.level === m.role.level)
                  ? []
                  : [{ value: String(m.role.level), label: roleDisplayText(m.role.name) }]),
                ...grantableRoles.map((r) => ({
                  value: String(r.level),
                  label: roleDisplayText(r.name),
                })),
              ]}
              value={String(m.role.level)}
              onValueChange={(v) => {
                void add(m.username, parseInt(v ?? "", 10))
              }}
            >
              <SelectTrigger size="sm" aria-label="Change role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {grantableRoles.map((r) => (
                    <SelectItem key={r.level} value={String(r.level)}>
                      <RoleLabel name={r.name} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}

          {/* Remove button for direct grants */}
          {!isLocked && !isSelf && m.role.source === "override" ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => void remove(m.userId)}
            >
              Remove
            </Button>
          ) : isLocked ? (
            <AppTooltip content={lockedHint}>
              <span className="text-[10px] text-muted-foreground">
                {lockedHint ?? ""}
              </span>
            </AppTooltip>
          ) : null}

          {/* Revoke all — available when session exists + maintainer+ */}
          {session?.jwt && !isSelf && (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1 text-destructive/70 hover:text-destructive"
              title="Revoke all access to this project"
              onClick={() => setRevokeTarget(m)}
            >
              <ShieldOff className="h-3.5 w-3.5" />
              Revoke all
            </Button>
          )}
        </div>
      </li>
    )
  }

  // AQU-485: the project's org rosterViewMinRole policy hides the roster
  // from this caller. Render a distinct "hidden" state — no member list, no
  // count, and no add-member form (which would itself imply an editable
  // roster exists) — never an empty shell that leaks "zero members."
  if (rosterHidden) {
    return (
      <div className={className}>
        <div className="flex flex-col items-center gap-2 rounded border py-10 text-center text-muted-foreground">
          <Lock className="h-5 w-5" />
          <p className="text-sm font-medium text-foreground">Roster hidden</p>
          <p className="max-w-xs text-xs">
            This organization has restricted who can view the member list. Ask an owner or
            maintainer if you need access.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={className}>
      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button
            type="button"
            className="ml-auto text-xs underline"
            onClick={() => void refresh()}
          >
            Retry
          </button>
        </div>
      )}

      {/* Members list */}
      <div>
        {/* AQU-488: explicit scope label. A first-time PM opening this
            section cold must be able to tell at a glance whether it's
            listing this project's people or the whole org — this list is
            always project-scoped (the effective roster for THIS project,
            per-row labeled with how each person got access below). */}
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">
            {orgAccessMembers.length > 0 ? "Project members" : "Current members"}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-muted-foreground"
            onClick={() => void refresh()}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
        {members.length > 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            Everyone who currently has access to this project. Each row shows how
            they got it — direct invite, org membership, or team.
          </p>
        )}

        {isLoading && members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading members…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <>
            {projectMembers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No one has been added directly to this project yet.
              </p>
            ) : (
              <ul className="divide-y rounded border">
                {projectMembers.map(renderMemberRow)}
              </ul>
            )}

            {/* AQU-454: org-wide members reach this project via their org role,
                not a project grant. Kept visible (per spec) but sectioned so the
                roster above reads as the actual project team. */}
            {orgAccessMembers.length > 0 && (
              <div className="mt-5" data-testid="org-access-members">
                <h3 className="mb-1 text-sm font-medium">
                  Organization members with access
                </h3>
                <p className="mb-2 text-xs text-muted-foreground">
                  {orgAccessMembers.length}{" "}
                  {orgAccessMembers.length === 1 ? "person has" : "people have"}{" "}
                  access through their organization role — they were not added to
                  this project directly. Remove them from the org to revoke.
                </p>
                <ul className="divide-y rounded border">
                  {orgAccessMembers.map(renderMemberRow)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {/* Add member */}
      <div className="rounded border p-4 space-y-3">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-muted-foreground" />
          Add member
        </h2>
        <div className="flex gap-2">
          <Input
            placeholder="Aquilla username"
            value={newUsername}
            onChange={(e) => {
              setNewUsername(e.target.value)
              setAddError(null)
              setAddForbidden(false)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd()
            }}
            disabled={adding}
            className="flex-1"
          />
          <Select
            items={grantableRoles.map((r) => ({
              value: String(r.level),
              label: roleDisplayText(r.name),
            }))}
            value={String(newRole)}
            onValueChange={(v) => setNewRole(parseInt(v ?? "", 10))}
            disabled={adding}
          >
            <SelectTrigger aria-label="Role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {grantableRoles.map((r) => (
                  <SelectItem key={r.level} value={String(r.level)}>
                    <RoleLabel name={r.name} />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => void handleAdd()}
            disabled={adding || !newUsername.trim()}
          >
            {adding ? "Adding…" : "Add"}
          </Button>
        </div>
        {addForbidden ? (
          <PermissionDeniedAlert
            action="add members to this project"
            requiredRole="Maintainer or higher"
          />
        ) : addError ? (
          <p className="text-xs text-destructive">{addError}</p>
        ) : null}
      </div>

      {/* Revoke-all dialog */}
      {revokeTarget && (
        <RevokeAllDialog
          member={revokeTarget}
          projectId={projectId}
          onClose={() => setRevokeTarget(null)}
          onRevoked={() => {
            setRevokeTarget(null)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Revoke-all confirmation dialog
// ──────────────────────────────────────────────────────────────────────────

interface RevokeAllDialogProps {
  member: ProjectMember
  projectId: string
  onClose: () => void
  onRevoked: () => void
}

function RevokeAllDialog({
  member, projectId, onClose, onRevoked,
}: RevokeAllDialogProps) {
  const { session } = useFrontierSession()
  const [confirmation, setConfirmation] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RevokeAllResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The user must type the member's username to confirm.
  const confirmationRequired = member.username
  const confirmed = confirmation.trim() === confirmationRequired

  async function handleRevoke() {
    if (!session?.jwt || !confirmed) return
    setBusy(true)
    setError(null)
    try {
      const r = await revokeAllProjectAccess(session.jwt, projectId, member.userId)
      setResult(r)
    } catch (e) {
      setError(toUserFacingError(e, "project").message)
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    // Show summary of what happened
    const remainingNonRemovable = result.grantPaths.filter((p) => !p.removable)
    return (
      <Dialog open onOpenChange={(v) => { if (!v) onRevoked() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Access revoked</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {result.removed ? (
              <p>
                Direct grant for <strong>{member.username}</strong> has been removed.
              </p>
            ) : (
              <p>
                <strong>{member.username}</strong> had no direct grant to remove.
              </p>
            )}
            {remainingNonRemovable.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                <p className="mb-2 font-medium text-amber-800 dark:text-amber-300">
                  Access still granted via:
                </p>
                <ul className="space-y-1">
                  {remainingNonRemovable.map((p, i) => (
                    <li key={i} className="text-xs text-amber-700 dark:text-amber-400">
                      <span className="font-medium capitalize">{p.source}</span>
                      {" "}({p.name})
                      {p.hint ? ` — ${p.hint}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={onRevoked}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldOff className="h-5 w-5" />
            Revoke all access
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <p>
            This will remove <strong>{member.username}</strong>&apos;s direct
            membership grant from this project. Any access they have via org,
            group, or creator status will remain.
          </p>

          {/* Show known grant paths */}
          <div className="rounded border p-3 space-y-1">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Current grant paths for {member.username}:
            </p>
            <GrantPathRow
              source={member.role.source}
              level={member.role.level}
              name={member.role.name}
              removable={member.role.source === "override"}
            />
            {member.secondarySources?.map((s, i) => (
              <GrantPathRow
                key={i}
                source={s.source}
                level={s.level}
                name={s.name}
                removable={false}
              />
            ))}
          </div>

          <div className="space-y-1">
            <FieldLabel htmlFor="revoke-confirm" className="text-xs">
              Type <strong>{confirmationRequired}</strong> to confirm
            </FieldLabel>
            <Input
              id="revoke-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={confirmationRequired}
              autoComplete="off"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!confirmed || busy}
            onClick={() => void handleRevoke()}
          >
            {busy ? "Revoking…" : "Revoke access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Invite-link tab (reuses SharePanel's InviteLinkTab logic)
// ──────────────────────────────────────────────────────────────────────────

function InviteLinkTab({ projectId }: { projectId: string }) {
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
        expiresInDays,
      )
      if (!serverInvite) {
        setServerError(
          "Couldn't create invite. You may not have permission, or the server is unreachable.",
        )
        return
      }
      const url = `${window.location.origin}/join/${serverInvite.token}`
      setIssuedUrl(url)
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
      <div className="mx-auto max-w-lg space-y-4">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <LinkIcon className="h-4 w-4 text-muted-foreground" />
          Invite link ready
        </h2>
        <p className="text-sm text-muted-foreground">
          Send this link to the recipient. Anyone with the link can join.
        </p>
        <div className="flex items-center gap-1">
          <Input value={issuedUrl} readOnly className="text-xs font-mono" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => copyUrl(issuedUrl)}
            title="Copy URL"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
        {copied && <p className="text-xs text-green-600">Copied!</p>}
        <p className="text-[10px] text-muted-foreground">
          The recipient signs in (or signs up) and is added as{" "}
          {LINK_ROLE_OPTIONS.find((o) => o.level === inviteRole)?.name ?? "a member"}.
          To revoke later, use the Members tab to remove them.
        </p>
        <Button size="sm" variant="outline" onClick={reset} className="w-full">
          Create another link
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h2 className="text-sm font-medium flex items-center gap-2">
        <LinkIcon className="h-4 w-4 text-muted-foreground" />
        Create invite link
      </h2>

      <div className="rounded border p-4 space-y-4">
        {/* Role */}
        <div className="space-y-1">
          <FieldLabel className="text-xs">Role</FieldLabel>
          <Select
            items={LINK_ROLE_OPTIONS.map((opt) => ({
              value: String(opt.level),
              label: roleDisplayText(opt.name),
            }))}
            value={String(inviteRole)}
            onValueChange={(v) => setInviteRole(Number(v ?? ""))}
            disabled={!session?.jwt}
          >
            <SelectTrigger className="w-full" aria-label="Role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LINK_ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.level} value={String(opt.level)}>
                    <RoleLabel name={opt.name} />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            {session?.jwt
              ? LINK_ROLE_OPTIONS.find((o) => o.level === inviteRole)?.description
              : "Sign in to create an invite link"}
          </p>
        </div>

        {/* Optional email */}
        <div className="space-y-1">
          <FieldLabel htmlFor="pm-invite-email" className="text-xs">
            Recipient email{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </FieldLabel>
          <Input
            id="pm-invite-email"
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
                ? "The join page prefills sign-up with this email."
                : "Leave blank for an open link anyone signed in can redeem."}
            </p>
          )}
        </div>

        {/* Expiry */}
        <div className="space-y-1">
          <FieldLabel className="text-xs">Link expires</FieldLabel>
          <Select
            items={EXPIRY_OPTIONS.map((opt) => ({
              value: String(opt.value),
              label: opt.label,
            }))}
            value={expiresInDays === null ? "null" : String(expiresInDays)}
            onValueChange={(v) =>
              setExpiresInDays(
                v === "null" || v === null ? null : Number(v),
              )
            }
            disabled={!session?.jwt}
          >
            <SelectTrigger className="w-full" aria-label="Link expires">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {EXPIRY_OPTIONS.map((opt) => (
                  <SelectItem key={String(opt.value)} value={String(opt.value)}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {serverError && (
          <p className="text-xs text-destructive">{serverError}</p>
        )}

        <Button
          size="sm"
          onClick={() => void handleCreate()}
          disabled={busy || !session?.jwt}
          className="w-full"
        >
          {busy ? "Creating…" : "Create invite link"}
        </Button>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

// AQU-488: human-readable access-path labels. auth-worker's resolveProjectRole
// (AD-12) returns one of these four `source` values per member — see
// ProjectMemberRole in src/lib/frontier/members.ts. Labeling every row (not
// just org-sourced ones) is what makes project-specific vs. org-wide
// membership visually distinct, per the AQU-488 acceptance criteria.
const SOURCE_LABELS: Record<string, string> = {
  override: "direct invite",
  group: "via team",
  org: "via org",
  creator: "project creator",
}

function SourceBadge({ source }: { source: string }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {SOURCE_LABELS[source] ?? source}
    </span>
  )
}

function GrantPathRow({
  source, level, name, removable,
}: {
  source: string
  level: number
  name: string
  removable: boolean
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cn("font-medium capitalize", removable ? "text-foreground" : "text-muted-foreground")}>
        {source}
      </span>
      <span className="text-muted-foreground">→ <RoleLabel name={name} /> (level {level})</span>
      {removable ? (
        <span className="text-xs text-destructive/70">will be removed</span>
      ) : (
        <span className="text-xs text-amber-600 dark:text-amber-400">stays</span>
      )}
    </div>
  )
}
