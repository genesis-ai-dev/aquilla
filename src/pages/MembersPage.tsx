import { useState } from "react"
import {
  AlertTriangle,
  Clock,
  Lock,
  Mail,
  UsersRound,
  X,
} from "lucide-react"
import { useLocation, useNavigate } from "react-router-dom"
import { membersPath } from "@/lib/navigation/org-paths"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { Page, PageHeader, Section, EmptyState } from "@/components/ui/page"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { useOrgMembers } from "@/hooks/useOrg"
import { useAccessibleProjects } from "@/hooks/useAccessibleProjects"
import { useOrgInvites } from "@/hooks/useOrgInvites"
import { MembersPanel, type MembersPanelMember } from "@/components/MembersPanel"
import { MembersMatrixView } from "@/components/MembersMatrixView"
import { MultiProjectInviteDialog } from "@/components/MultiProjectInviteDialog"
import { RemoveOrgMemberDialog } from "@/components/RemoveOrgMemberDialog"
import { OrgInviteByEmail } from "@/components/org/OrgInviteByEmail"
import { MemberAccessRow } from "@/components/org/MemberAccessPanel"
import { ExternalCollaboratorsSection } from "@/components/org/ExternalCollaboratorsSection"
import { ROLE, ORG_ROLE_PICKER, roleName } from "@/lib/frontier/roles"
import { RoleLabel } from "@/components/RoleLabel"
import { formatRelativeTime } from "@/lib/time/relative"
import type { OrgMemberProject, PendingOrgInvite } from "@/lib/frontier/orgs"
import type { MemberGrantResult } from "@/lib/frontier/members"
import { useActiveOrg } from "@/context/OrgContext"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"

type MembersTab = "roster" | "matrix"

// SWARM-TODO(AQU-832): ORG_ROLE_DESCRIPTIONS/the `description` field below are
// dead — MembersPanelRoleOption dropped `description` (AQU-832 wave 3/WS-08;
// see the comment on that interface in MembersPanel.tsx) so nothing ever
// reads it. Left un-keyed because it's not user-facing; consider deleting
// both instead of keying text nobody sees.
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
  const t = useT()
  const { activeOrg, isAllOrgs, isLoading, error } = useActiveOrg()

  if (isLoading) {
    return (
      <MembersShell>
        <Page size="wide">
          <PageHeader title={t("editor.navTitle.members")} description={t("org.membersPage.orgPage.description")} />
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
          <PageHeader title={t("editor.navTitle.members")} description={t("org.membersPage.orgPage.description")} />
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">{t("org.membersPage.orgPage.loadErrorTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("org.membersPage.orgPage.loadErrorHint")}
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
          <PageHeader title={t("editor.navTitle.members")} description={t("org.membersPage.orgPage.description")} />
          <EmptyState
            icon={AlertTriangle}
            title={isAllOrgs ? t("org.teamsList.selectOrgTitle") : t("org.membersPage.orgPage.signInTitle")}
            description={
              isAllOrgs
                ? t("org.membersPage.orgPage.selectOrgDescription")
                : t("org.membersPage.orgPage.signInDescription")
            }
          />
        </Page>
      </MembersShell>
    )
  }

  return <MembersPageContent orgId={activeOrg.id} orgName={activeOrg.name ?? t("org.breadcrumb.organizationFallback")} />
}

/**
 * Org-level chrome wrapper. Members is one section of the org workspace, so it
 * renders inside the same AppShell + OrgSidebar as Overview/Projects/Teams —
 * selecting "Members" from the sidebar swaps the main editor section without
 * dropping the org navigation. The main slot owns its own scroll because
 * AppShell's main wrapper is overflow-hidden and the roster can run tall.
 */
function MembersShell({ children }: { children: React.ReactNode }) {
  const t = useT()
  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={t("editor.navTitle.members")} />}
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
  const t = useT()
  const callerUserId = null // FrontierSession has no userId; server enforces self-block.
  const { activeOrg } = useActiveOrg()
  // AQU-326: the External-collaborators governance view is maintainer+ only.
  const canGovern = (activeOrg?.role.level ?? 0) >= ROLE.MAINTAINER
  const { members, isLoading: membersLoading, error: membersError, rosterHidden, add, addMany, remove, listMemberProjects, refresh } =
    useOrgMembers(orgId)
  const { projects: accessibleProjects, refresh: refreshProjects } = useAccessibleProjects()
  const [removeTarget, setRemoveTarget] = useState<{ userId: number; username: string } | null>(null)
  const [multiInviteOpen, setMultiInviteOpen] = useState(false)

  // AQU-538 §3.4: "Roster" (the org-wide member list, default) vs "Matrix"
  // (MembersMatrixView — members × projects role grid). Path-based so the
  // tab is linkable (`/orgs/:id/members/matrix`) and survives a refresh.
  const location = useLocation()
  const navigate = useNavigate()
  const tab: MembersTab = location.pathname.endsWith("/members/matrix") ? "matrix" : "roster"
  function setTab(next: MembersTab) {
    if (orgId == null) return
    navigate(membersPath(orgId, next), { replace: true })
  }

  const panelMembers: MembersPanelMember[] = members.map((m) => ({
    userId: m.userId,
    username: m.username,
    roleLevel: m.role.level,
    roleName: m.role.name,
    source: m.role.level === ROLE.OWNER ? "owner-of-org" : "override",
    isLocked: m.role.level === ROLE.OWNER,
    lockedHint: m.role.level === ROLE.OWNER ? t("org.membersPage.orgPage.orgOwnerHint") : undefined,
    lastActiveAt: m.lastActiveAt ?? null,
  }))

  const canInviteByEmail = (activeOrg?.role.level ?? 0) >= ROLE.OWNER

  return (
    <MembersShell>
      <Page size="wide">
      <PageHeader
        title={t("editor.navTitle.members")}
        description={
          <>
            {t("org.membersPage.orgPage.pageDescriptionPrefix")}{" "}
            <strong className="font-medium text-foreground">{orgName}</strong>
            {t("org.membersPage.orgPage.pageDescriptionSuffix")}
          </>
        }
        actions={
          <AppTooltip content={t("org.membersPage.orgPage.addToProjectsTooltip")}>
            <Button
              variant="default"
              size="sm"
              onClick={() => setMultiInviteOpen(true)}
              disabled={accessibleProjects.length === 0}
            >
              <UsersRound className="me-1.5 size-4" />
              {t("org.membersPage.orgPage.addToProjectsButton")}
            </Button>
          </AppTooltip>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as MembersTab)}>
        <TabsList aria-label={t("org.membersPage.orgPage.tabsAriaLabel")}>
          <TabsTrigger value="roster">{t("org.membersPage.orgPage.roster")}</TabsTrigger>
          <TabsTrigger value="matrix">{t("org.membersPage.orgPage.matrixTab")}</TabsTrigger>
        </TabsList>

        <TabsContent value="roster">
          <div className="space-y-6">
            {canInviteByEmail && (
              <Section
                title={t("org.membersPage.orgPage.inviteSectionTitle")}
                description={t("org.membersPage.orgPage.inviteSectionDescription")}
              >
                <OrgInviteByEmail orgId={orgId} />
              </Section>
            )}

            {membersError && (
              <p className="text-xs text-destructive">{membersError}</p>
            )}

            {membersLoading && members.length === 0 && !rosterHidden ? (
              <Section title={t("org.membersPage.orgPage.roster")}>
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Spinner className="me-2" />
                  <span className="text-sm">{t("org.membersPage.orgPage.loadingMembers")}</span>
                </div>
              </Section>
            ) : rosterHidden ? (
              // AQU-485: the org's rosterViewMinRole policy hides the roster (and
              // count) from this caller. Render a distinct "hidden" state — never
              // an empty roster, which would falsely imply zero members.
              <Section title={t("org.membersPage.orgPage.roster")}>
                <EmptyState
                  variant="inline"
                  icon={Lock}
                  title={t("org.membersPage.rosterHiddenTitle")}
                  description={t("org.membersPage.rosterHiddenBody")}
                />
              </Section>
            ) : (
              <>
                <RosterWithProjectChips
                  orgId={orgId}
                  panelMembers={panelMembers}
                  listMemberProjects={listMemberProjects}
                  add={add}
                  addMany={addMany}
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
        </TabsContent>

        <TabsContent value="matrix">
          {/* Mounted only while this tab is active — avoids firing the
              batched matrix fetch (and its per-row lazy scope fetches) when
              the operator is just looking at the roster. */}
          {tab === "matrix" && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {t("org.membersPage.orgPage.matrixHint")}
              </p>
              <MembersMatrixView />
            </div>
          )}
        </TabsContent>
      </Tabs>

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
  /** AQU-734: batch grant for the multi-select Add flow. */
  addMany: (members: Array<{ username: string; role: number }>) => Promise<MemberGrantResult[]>
  remove: (userId: number) => Promise<void>
  callerUserId: number | null
  /** AQU-427: the current user's org-level role, forwarded to MemberAccessRow
   *  so the Revoke button can be disabled-with-explanation for low roles. */
  callerOrgRoleLevel: number | null
  onRequestRemove: (userId: number, username: string) => void
}

function RosterWithProjectChips({
  orgId,
  panelMembers,
  add,
  addMany,
  callerUserId,
  callerOrgRoleLevel,
  onRequestRemove,
}: RosterProps) {
  const t = useT()
  return (
    <>
      <Section
        title={t("org.membersPage.orgPage.roster")}
        description={t("org.membersPage.orgPage.rosterSectionDescription")}
      >
        <MembersPanel
          members={panelMembers}
          roleOptions={ORG_ROLE_OPTIONS}
          newMemberDefaultRole={ROLE.MAINTAINER}
          callerUserId={callerUserId}
          callerMaxRole={ROLE.MAINTAINER}
          scopedUserSearch={false}
          onAdd={async (usernames, role) => {
            const results = await addMany(usernames.map((username) => ({ username, role })))
            return results.map((r) => ({
              username: r.username,
              ok: r.ok,
              error: r.error?.message,
            }))
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
        title={t("org.membersPage.orgPage.projectAccessTitle")}
        description={t("org.membersPage.orgPage.projectAccessDescription")}
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
  const t = useT()
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
          {t("org.orgHome.pendingInvitations.heading")}
        </span>
      }
      description={t("org.membersPage.orgPage.pendingInvitesDescription")}
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
  const t = useT()
  const [busy, setBusy] = useState(false)
  // SWARM-TODO(AQU-832): formatRelativeTime (src/lib/time/relative.ts) itself
  // returns hardcoded, un-i18n'd English ("3 days ago") — out of scope here
  // (shared util, many other call sites). This wrapper's own literal text is
  // keyed below; the relative-time fragment inside it stays English until
  // that util is localized.
  const expiresLabel = invite.expiresAt
    ? t("org.membersPage.orgPage.expiresRelativePrefix", {
        relative: formatRelativeTime(invite.expiresAt)?.replace(" ago", " from now") ?? "",
      })
    : t("org.membersPage.orgPage.noExpiry")
  // Hack-y: formatRelativeTime is past-tense; for an expiry we want
  // "expires in 2 days". Recompute properly when expiresAt is in the future.
  const futureLabel = computeFutureLabel(t, invite.expiresAt)

  return (
    <li className="flex items-center gap-2 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium truncate">{invite.projectName}</span>
          <span className="text-muted-foreground">·</span>
          <RoleLabel name={invite.role.name} className="text-muted-foreground" />
          {invite.email ? (
            <AppTooltip content={t("org.membersPage.orgPage.targetedInviteTooltip")}>
              <span className="rounded bg-blue-500/15 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 text-[9px] font-mono">
                {invite.email}
              </span>
            </AppTooltip>
          ) : (
            <AppTooltip content={t("org.membersPage.orgPage.openLinkTooltip")}>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                {t("projectSettings.share.openLinkConnector")}
              </span>
            </AppTooltip>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>
            {t("org.membersPage.orgPage.invitedByLabel", {
              username: invite.createdBy?.username ?? t("org.membersPage.orgPage.unknownInviter"),
            })}
          </span>
          <span>·</span>
          <Clock className="h-2.5 w-2.5" />
          <span>{futureLabel ?? expiresLabel}</span>
        </div>
      </div>
      <AppTooltip content={t("org.membersPage.orgPage.revokeInviteTooltip")}>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          disabled={busy}
          aria-label={t("org.membersPage.orgPage.revokeInviteAriaLabel", { project: invite.projectName })}
          onClick={async () => {
            setBusy(true)
            try {
              await onRevoke(invite.projectId, invite.token)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? <Spinner className="size-3.5" /> : <X />}
        </Button>
      </AppTooltip>
    </li>
  )
}

/** "expires in 2 days" / "expired" / null when no expiry set. */
function computeFutureLabel(t: TFunction, iso: string | null): string | null {
  if (!iso) return null
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return null
  const ms = parsed - Date.now()
  if (ms <= 0) return t("org.membersPage.orgPage.expired")
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days >= 1) return t("org.membersPage.orgPage.expiresInDays", { count: days })
  const hours = Math.floor(ms / (60 * 60 * 1000))
  if (hours >= 1) return t("org.membersPage.orgPage.expiresInHours", { count: hours })
  const minutes = Math.max(1, Math.floor(ms / (60 * 1000)))
  return t("org.membersPage.orgPage.expiresInMinutes", { count: minutes })
}
