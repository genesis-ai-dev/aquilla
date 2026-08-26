import { useState } from "react"
import {
  AlertTriangle,
  Clock,
  Mail,
  X,
} from "lucide-react"
import { useLocation, useNavigate, Navigate } from "react-router-dom"
import { membersPath, orgOverviewPath } from "@/lib/navigation/org-paths"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { Page, PageHeader, Section, EmptyState } from "@/components/ui/page"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { OrgMembersTable } from "@/components/org/OrgMembersTable"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { DataTablePanelSkeleton } from "@/components/ui/data-table"
import { useOrgMembers } from "@/hooks/useOrg"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { useAccessibleProjects } from "@/hooks/useAccessibleProjects"
import { useOrgInvites } from "@/hooks/useOrgInvites"
import { MembersMatrixView } from "@/components/MembersMatrixView"
import { MultiProjectInviteDialog } from "@/components/MultiProjectInviteDialog"
import { RemoveOrgMemberDialog } from "@/components/RemoveOrgMemberDialog"
import { ExternalCollaboratorsSection } from "@/components/org/ExternalCollaboratorsSection"
import { ROLE } from "@/lib/frontier/roles"
import { RoleLabel } from "@/components/RoleLabel"
import { formatRelativeTime } from "@/lib/time/relative"
import type { PendingOrgInvite } from "@/lib/frontier/orgs"
import { useActiveOrg } from "@/context/OrgContext"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"

type MembersTab = "roster" | "matrix"

/**
 * Operational PM home. Org members render as a Teams-style DataTable (search,
 * toolbar actions, row menus). Matrix stays a second tab for the members ×
 * projects grid.
 */
export function MembersPage() {
  const t = useT()
  const { activeOrg, isAllOrgs, isLoading, error } = useActiveOrg()

  if (isLoading) {
    return (
      <MembersShell>
        <Page size="wide">
          <PageHeader
            title={t("editor.navTitle.members")}
            description={t("org.membersPage.orgPage.description")}
            inset={false}
          />
          <DataTablePanelSkeleton
            searchPlaceholder="Search by name or email"
            loadingLabel={t("org.membersPage.loadingMembers")}
            className={ADMIN_TABLE_PANEL_CLASS}
          />
        </Page>
      </MembersShell>
    )
  }

  if (error) {
    return (
      <MembersShell>
        <Page size="wide">
          <PageHeader
            title={t("editor.navTitle.members")}
            description={t("org.membersPage.orgPage.description")}
            inset={false}
          />
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
          <PageHeader
            title={t("editor.navTitle.members")}
            description={t("org.membersPage.orgPage.description")}
            inset={false}
          />
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
  const { activeOrg } = useActiveOrg()
  const { canViewRoster, hasFetched: rosterPolicyReady } = useOrgSettings(
    orgId,
    activeOrg?.role?.level,
  )
  // AQU-326: the External-collaborators governance view is maintainer+ only.
  const canGovern = (activeOrg?.role.level ?? 0) >= ROLE.MAINTAINER
  const { members, isLoading: membersLoading, error: membersError, rosterHidden, add, addMany, remove, listMemberProjects, refresh } =
    useOrgMembers(orgId)
  const {
    projects: accessibleProjects,
    error: accessibleProjectsError,
    refresh: refreshProjects,
  } = useAccessibleProjects()
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

  // AQU-485: below-floor callers must not see this page exist. Redirect to
  // the org overview rather than a "Roster hidden" disclosure.
  if (!rosterPolicyReady) {
    return (
      <MembersShell>
        <Page size="wide">
          <PageHeader
            title={t("editor.navTitle.members")}
            description={t("org.membersPage.orgPage.description")}
            inset={false}
          />
          <DataTablePanelSkeleton
            searchPlaceholder="Search by name or email"
            loadingLabel={t("org.membersPage.loadingMembers")}
            className={ADMIN_TABLE_PANEL_CLASS}
          />
        </Page>
      </MembersShell>
    )
  }
  if (!canViewRoster || rosterHidden) {
    return <Navigate to={orgOverviewPath(orgId)} replace />
  }

  return (
    <MembersShell>
      <Page size="wide">
      <PageHeader
        title={t("editor.navTitle.members")}
        description={t("org.membersPage.orgPage.description")}
        inset={false}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as MembersTab)}>
        <TabsList aria-label={t("org.membersPage.orgPage.tabsAriaLabel")}>
          <TabsTrigger value="roster">{t("org.membersPage.orgPage.roster")}</TabsTrigger>
          <TabsTrigger value="matrix">{t("org.membersPage.orgPage.matrixTab")}</TabsTrigger>
        </TabsList>

        <TabsContent value="roster">
          <div className="space-y-6">
            {membersError && (
              <p className="text-xs text-destructive">{membersError}</p>
            )}
            {accessibleProjectsError && (
              <p className="text-xs text-destructive">{accessibleProjectsError}</p>
            )}

            <OrgMembersTable
                  orgId={orgId}
                  members={members}
                  loading={membersLoading && members.length === 0}
                  callerOrgRoleLevel={activeOrg?.role.level ?? null}
                  canAddToProjects={accessibleProjects.length > 0}
                  onAddToProjects={() => setMultiInviteOpen(true)}
                  add={add}
                  addMany={addMany}
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
          <RoleLabel name={invite.role.name} />
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
