import { useState } from "react"
import {
  AlertTriangle,
  Clock,
  Mail,
  UsersRound,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { Page, PageHeader, Section, EmptyState } from "@/components/ui/page"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { useOrgMembers } from "@/hooks/useOrg"
import { useAccessibleProjects } from "@/hooks/useAccessibleProjects"
import { useOrgInvites } from "@/hooks/useOrgInvites"
import { MembersPanel, type MembersPanelMember } from "@/components/MembersPanel"
import { MultiProjectInviteDialog } from "@/components/MultiProjectInviteDialog"
import { RemoveOrgMemberDialog } from "@/components/RemoveOrgMemberDialog"
import { OrgInviteByEmail } from "@/components/org/OrgInviteByEmail"
import { MemberAccessRow } from "@/components/org/MemberAccessPanel"
import { ExternalCollaboratorsSection } from "@/components/org/ExternalCollaboratorsSection"
import { ROLE, ORG_ROLE_PICKER, roleName } from "@/lib/frontier/roles"
import { formatRelativeTime } from "@/lib/time/relative"
import type { OrgMemberProject, PendingOrgInvite } from "@/lib/frontier/orgs"
import { useActiveOrg } from "@/context/OrgContext"

const ORG_ROLE_DESCRIPTIONS: Record<number, string> = {
  [ROLE.VIEWER]: "Read-only across all projects",
  [ROLE.CONTRIBUTOR]: "Edit content across all projects",
  [ROLE.PROJECT_LEAD]: "Manage members on every project",
  [ROLE.MAINTAINER]: "Lead + manage roles",
}

const ORG_ROLE_OPTIONS = ORG_ROLE_PICKER.map((level) => ({
  level,
  name: roleName(level),
  description: ORG_ROLE_DESCRIPTIONS[level] ?? "",
}))

/**
 * Operational PM home. The previous /settings/org page collapsed three
 * states into "Loading…" — pre-session, fetching, and silent error all
 * looked the same to the user. This page renders each state distinctly,
 * and adds the multi-project invite + per-member project chips that the
 * design loop concluded operational PMs need.
 */
export function MembersPage() {
  const { activeOrg, isAllOrgs, isLoading, error } = useActiveOrg()

  if (isLoading) {
    return (
      <MembersShell>
        <Page size="wide">
          <PageHeader title="Members" description="People in this organization and their access." />
          <div className="space-y-4">
            <div className="h-24 animate-pulse rounded-2xl border bg-card" />
            <div className="h-40 animate-pulse rounded-2xl border bg-card" />
          </div>
        </Page>
      </MembersShell>
    )
  }

  if (error) {
    return (
      <MembersShell>
        <Page size="wide">
          <PageHeader title="Members" description="People in this organization and their access." />
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">Couldn't load your organization</p>
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Common causes: the Frontier worker is unreachable, your session expired,
              or the request timed out. Check your network and try again.
            </p>
          </div>
        </Page>
      </MembersShell>
    )
  }

  if (!activeOrg) {
    return (
      <MembersShell>
        <Page size="wide">
          <PageHeader title="Members" description="People in this organization and their access." />
          <EmptyState
            icon={AlertTriangle}
            title={isAllOrgs ? "Select an organization" : "Sign in to manage members"}
            description={
              isAllOrgs
                ? "Member access is managed within a single organization. Choose one from the switcher to continue."
                : "Member access requires a Frontier session. Sign in from the dashboard and come back to this page."
            }
          />
        </Page>
      </MembersShell>
    )
  }

  return <MembersPageContent orgId={activeOrg.id} orgName={activeOrg.name ?? "Organization"} />
}

/**
 * Org-level chrome wrapper. Members is one section of the org workspace, so it
 * renders inside the same AppShell + OrgSidebar as Overview/Projects/Teams —
 * selecting "Members" from the sidebar swaps the main editor section without
 * dropping the org navigation. The main slot owns its own scroll because
 * AppShell's main wrapper is overflow-hidden and the roster can run tall.
 */
function MembersShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Members" />}
      statusBar={null}
      main={children}
    />
  )
}

interface MembersPageContentProps {
  orgId: number
  orgName: string
}

function MembersPageContent({ orgId, orgName }: MembersPageContentProps) {
  const callerUserId = null // FrontierSession has no userId; server enforces self-block.
  const { activeOrg } = useActiveOrg()
  // FRO-326: the External-collaborators governance view is maintainer+ only.
  const canGovern = (activeOrg?.role.level ?? 0) >= ROLE.MAINTAINER
  const { members, isLoading: membersLoading, error: membersError, add, remove, listMemberProjects, refresh } =
    useOrgMembers(orgId)
  const { projects: accessibleProjects, refresh: refreshProjects } = useAccessibleProjects()
  const [removeTarget, setRemoveTarget] = useState<{ userId: number; username: string } | null>(null)
  const [multiInviteOpen, setMultiInviteOpen] = useState(false)

  const panelMembers: MembersPanelMember[] = members.map((m) => ({
    userId: m.userId,
    username: m.username,
    roleLevel: m.role.level,
    roleName: m.role.name,
    source: m.role.level === ROLE.OWNER ? "owner-of-org" : "override",
    isLocked: m.role.level === ROLE.OWNER,
    lockedHint: m.role.level === ROLE.OWNER ? "Org owner" : undefined,
    lastActiveAt: m.lastActiveAt ?? null,
  }))

  const canInviteByEmail = (activeOrg?.role.level ?? 0) >= ROLE.OWNER

  return (
    <MembersShell>
      <Page size="wide">
      <PageHeader
        title="Members"
        description={
          <>
            People in <strong className="font-medium text-foreground">{orgName}</strong>.
            Org-level roles apply across every project; per-project access can be
            granted separately via the Add-to-projects flow.
          </>
        }
        actions={
          <AppTooltip content="Add someone to specific projects without granting org-wide access.">
            <Button
              variant="default"
              size="sm"
              onClick={() => setMultiInviteOpen(true)}
              disabled={accessibleProjects.length === 0}
            >
              <UsersRound className="mr-1.5 size-4" />
              Add to projects
            </Button>
          </AppTooltip>
        }
      />

      <div className="space-y-6">
        {canInviteByEmail && (
          <Section
            title="Invite a teammate by email"
            description="Bring someone new into this organization. They don't need an Aquilla account yet — they'll be guided to create one when they accept."
          >
            <OrgInviteByEmail orgId={orgId} />
          </Section>
        )}

        {membersError && (
          <p className="text-xs text-destructive">{membersError}</p>
        )}

        {membersLoading && members.length === 0 ? (
          <Section title="Roster">
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Spinner className="mr-2" />
              <span className="text-sm">Loading members…</span>
            </div>
          </Section>
        ) : (
          <>
            <RosterWithProjectChips
              orgId={orgId}
              panelMembers={panelMembers}
              listMemberProjects={listMemberProjects}
              add={add}
              remove={remove}
              callerUserId={callerUserId}
              callerOrgRoleLevel={activeOrg?.role.level ?? null}
              onRequestRemove={(userId, username) =>
                setRemoveTarget({ userId, username })
              }
            />
            <PendingInvitesSection orgId={orgId} />
            {canGovern && (
              <ExternalCollaboratorsSection
                orgId={orgId}
                orgMemberIds={members.map((m) => m.userId)}
              />
            )}
          </>
        )}
      </div>

      {removeTarget && (
        <RemoveOrgMemberDialog
          orgId={orgId}
          orgName={orgName}
          userId={removeTarget.userId}
          username={removeTarget.username}
          listProjects={() => listMemberProjects(removeTarget.userId)}
          onClose={() => setRemoveTarget(null)}
          onConfirmed={async () => {
            await remove(removeTarget.userId)
            await refresh()
            setRemoveTarget(null)
          }}
        />
      )}

      <MultiProjectInviteDialog
        open={multiInviteOpen}
        onOpenChange={setMultiInviteOpen}
        projects={accessibleProjects}
        onSuccess={() => {
          // Roster doesn't change (org membership unchanged), but refresh
          // accessible-projects list so future opens reflect any org_id
          // changes that might have happened.
          void refreshProjects()
        }}
      />
      </Page>
    </MembersShell>
  )
}

/**
 * Roster + per-row inline expand for project memberships. Keeps the existing
 * MembersPanel for add/remove/role-change, and adds a row affordance to
 * see "where on the project portfolio is this person" without leaving the
 * page. Lazy-fetched: the list_member_projects round-trip only fires when
 * the row is expanded.
 */
interface RosterProps {
  orgId: number
  panelMembers: MembersPanelMember[]
  listMemberProjects: (userId: number) => Promise<OrgMemberProject[]>
  add: (username: string, role: number) => Promise<unknown>
  remove: (userId: number) => Promise<void>
  callerUserId: number | null
  /** FRO-427: the current user's org-level role, forwarded to MemberAccessRow
   *  so the Revoke button can be disabled-with-explanation for low roles. */
  callerOrgRoleLevel: number | null
  onRequestRemove: (userId: number, username: string) => void
}

function RosterWithProjectChips({
  orgId,
  panelMembers,
  add,
  callerUserId,
  callerOrgRoleLevel,
  onRequestRemove,
}: RosterProps) {
  return (
    <>
      <Section
        title="Roster"
        description="Org members and their org-wide role. Add by username, change a role, or remove someone."
      >
        <MembersPanel
          members={panelMembers}
          roleOptions={ORG_ROLE_OPTIONS}
          defaultRole={ROLE.MAINTAINER}
          callerUserId={callerUserId}
          callerMaxRole={ROLE.MAINTAINER}
          scopedUserSearch={false}
          onAdd={async (username, role) => {
            const result = await add(username, role)
            return result
              ? { ok: true }
              : { ok: false, error: "Could not add user. Username may not exist." }
          }}
          onRemove={(userId) => {
            const target = panelMembers.find((m) => m.userId === userId)
            if (target) onRequestRemove(target.userId, target.username)
            return Promise.resolve()
          }}
          onChangeRole={async (username, role) => {
            await add(username, role)
          }}
        />
      </Section>

      <Section
        title="Project access"
        description="Expand a member to see their per-project roles."
      >
        <ul className="divide-y">
          {panelMembers.map((m) => (
            <MemberAccessRow
              key={m.userId}
              orgId={orgId}
              userId={m.userId}
              username={m.username}
              callerOrgRoleLevel={callerOrgRoleLevel}
            />
          ))}
        </ul>
      </Section>
    </>
  )
}


/**
 * Pending share-link invitations across this org. Owner-only (the server
 * gates the listing, returning null on 403, and the hook hides the section
 * for non-owners). Each row shows what was invited where, by whom, and an
 * expiry hint; the trash icon revokes (DELETE /projects/:id/invites/:token).
 *
 * Optimistic revoke: the row disappears immediately on click. If the
 * server later errors, the hook re-fetches and the row reappears.
 */
function PendingInvitesSection({ orgId }: { orgId: number }) {
  const { invites, isLoading, error, revoke } = useOrgInvites(orgId)

  // Non-owner callers (server returned null/403) → hide the section entirely.
  // No-pending case → also hide; nothing for the operator to act on.
  if (invites === null) return null
  if (!isLoading && invites.length === 0) return null

  return (
    <Section
      title={
        <span className="flex items-center gap-1.5">
          <Mail className="size-4 text-muted-foreground" aria-hidden />
          Pending invitations
        </span>
      }
      description="Share-link invitations that haven't been redeemed yet. Revoke to cancel."
      action={isLoading ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
    >
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}

      {invites.length > 0 && (
        <ul className="divide-y">
          {invites.map((inv) => (
            <PendingInviteRow key={inv.token} invite={inv} onRevoke={revoke} />
          ))}
        </ul>
      )}
    </Section>
  )
}

function PendingInviteRow({
  invite,
  onRevoke,
}: {
  invite: PendingOrgInvite
  onRevoke: (projectId: string, token: string) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const expiresLabel = invite.expiresAt
    ? `expires ${formatRelativeTime(invite.expiresAt)?.replace(" ago", " from now") ?? ""}`
    : "no expiry"
  // Hack-y: formatRelativeTime is past-tense; for an expiry we want
  // "expires in 2 days". Recompute properly when expiresAt is in the future.
  const futureLabel = computeFutureLabel(invite.expiresAt)

  return (
    <li className="flex items-center gap-2 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium truncate">{invite.projectName}</span>
          <span className="text-muted-foreground">·</span>
          <span className="capitalize text-muted-foreground">
            {invite.role.name.replace(/_/g, " ")}
          </span>
          {invite.email ? (
            <AppTooltip content="Targeted invite: sign-up form will be prefilled with this email">
              <span className="rounded bg-blue-500/15 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 text-[9px] font-mono">
                {invite.email}
              </span>
            </AppTooltip>
          ) : (
            <AppTooltip content="Open link: anyone holding the URL can redeem">
              <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                open link
              </span>
            </AppTooltip>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>by {invite.createdBy?.username ?? "unknown"}</span>
          <span>·</span>
          <Clock className="h-2.5 w-2.5" />
          <span>{futureLabel ?? expiresLabel}</span>
        </div>
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-muted-foreground hover:text-destructive"
        disabled={busy}
        title="Revoke invitation"
        aria-label={`Revoke invitation to ${invite.projectName}`}
        onClick={async () => {
          setBusy(true)
          try {
            await onRevoke(invite.projectId, invite.token)
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? <Spinner className="size-3.5" /> : <X className="h-3.5 w-3.5" />}
      </Button>
    </li>
  )
}

/** "expires in 2 days" / "expired" / null when no expiry set. */
function computeFutureLabel(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const ms = t - Date.now()
  if (ms <= 0) return "expired"
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days >= 1) return `expires in ${days} day${days === 1 ? "" : "s"}`
  const hours = Math.floor(ms / (60 * 60 * 1000))
  if (hours >= 1) return `expires in ${hours} hour${hours === 1 ? "" : "s"}`
  const minutes = Math.max(1, Math.floor(ms / (60 * 1000)))
  return `expires in ${minutes} minute${minutes === 1 ? "" : "s"}`
}
