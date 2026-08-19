import { startTransition, type ComponentProps, type MouseEvent } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import type { LucideIcon } from "lucide-react"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin"
import { partitionSharedProjects } from "@/lib/frontier/shared-projects"
import { isProjectNew, readProjectOpenedAt } from "@/lib/frontier/opened-shared-store"
import { Badge } from "@/components/ui/badge"
import {
  orgHomePath,
  orgPath,
  orgOverviewPath,
  orgProjectsPath,
  ALL_ORGS_PARAM,
} from "@/lib/navigation/org-paths"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { OrgSwitcher } from "./OrgSwitcher"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { useT } from "@/lib/i18n/I18nProvider"

const link = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-normal ${isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`

function NavIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4 shrink-0" aria-hidden />
}

/** Preserve the current org surface while a lazy destination chunk resolves.
 * Modified/new-tab clicks retain normal anchor behavior. */
function OrgNavLink(props: ComponentProps<typeof NavLink>) {
  const navigate = useNavigate()
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(event)
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      props.reloadDocument
    ) return
    event.preventDefault()
    startTransition(() => navigate(props.to, { replace: props.replace, state: props.state }))
  }
  return <NavLink {...props} onClick={handleClick} />
}

export function OrgSidebar() {
  const t = useT()
  const { orgs, activeOrg, activeOrgId, activeGuestOrg, isAllOrgs, accessibleProjects } = useActiveOrg()
  const { session } = useFrontierSession()
  const username = session?.username ?? null
  // AQU-790: in a guest org the caller has project-level access only — no org
  // membership. Member-scoped nav (Teams, Assigned, Members, Archived,
  // Settings) is hidden so nothing links into an org they can't operate on
  // (previously these rendered for the caller's *owned* active org and silently
  // switched context on click).
  const isGuestOrg = activeGuestOrg != null
  const isMemberOrg = !isAllOrgs && activeOrgId != null && !isGuestOrg
  const isAdmin = isMemberOrg && (activeOrg?.role.level ?? 0) >= 600
  // Platform-operator (site-wide admin) — separate axis from the org role.
  const { isAdmin: isPlatformAdmin } = usePlatformAdmin()

  // FRO-474: project-only invitees (direct project_members grant, no org
  // membership for that project) have no org-scoped nav surface to reach
  // their project. AQU-417: rather than scatter those projects under every
  // org's nav, expose ONE dedicated entry — a single "Shared with you" link to
  // the /shared page that collects them all in one place — shown whenever the
  // caller has at least one cross-org grant. Reachability is preserved for
  // zero-org invitees (the link and the /shared route work regardless of org
  // membership, unlike the all-orgs overview which requires 2+ member orgs).
  const sharedWithMe =
    partitionSharedProjects(accessibleProjects, orgs, activeOrgId).sharedWithMe
  const hasSharedProjects = sharedWithMe.length > 0
  // AQU-696: light the nav entry while ANY shared project is still unopened —
  // it clears only once every "New" project has been opened. Read
  // synchronously: the sidebar remounts on navigation (each page renders its
  // own AppShell/OrgSidebar), so returning here after opening a project
  // re-reads a fresh "opened" record.
  const hasNewSharedProjects =
    username != null &&
    sharedWithMe.some((p) =>
      isProjectNew(p.grantedAt, readProjectOpenedAt(username, p.id)),
    )

  const portfolioHomeTo = isAllOrgs
    ? orgHomePath(ALL_ORGS_PARAM)
    : activeOrgId != null
      ? orgHomePath(activeOrgId)
      : orgHomePath(ALL_ORGS_PARAM)

  return (
    <div className="flex h-full min-w-0 flex-col gap-1 overflow-hidden p-2">
      <div data-tour="org-switcher">
        <OrgSwitcher />
      </div>
      <nav className="mt-2 flex flex-1 flex-col gap-0.5">
        {/* Guest org: single project list at org index. Member: Overview + Projects. */}
        {isGuestOrg && activeOrgId != null ? (
          <OrgNavLink
            to={orgHomePath(activeOrgId)}
            end
            className={link}
            data-tour="nav-overview"
          >
            <NavIcon icon={NAV_PAGE_ICONS.projects} />
            {t("nav.projects")}
          </OrgNavLink>
        ) : isMemberOrg && activeOrgId != null ? (
          <>
            <OrgNavLink
              to={orgOverviewPath(activeOrgId)}
              end
              className={link}
              data-tour="nav-overview"
            >
              <NavIcon icon={NAV_PAGE_ICONS.overview} />
              {t("editor.navTitle.overview")}
            </OrgNavLink>
            <OrgNavLink
              to={orgProjectsPath(activeOrgId)}
              className={link}
              data-tour="nav-projects"
            >
              <NavIcon icon={NAV_PAGE_ICONS.projects} />
              {t("nav.projects")}
            </OrgNavLink>
          </>
        ) : (
          // All organizations: single portfolio home (OrgHome). There is no
          // separate /projects tool under `/orgs/all`, so label it Overview —
          // matching member-org Overview, not the Teams-style Projects table.
          <OrgNavLink
            to={portfolioHomeTo}
            end
            className={link}
            data-tour="nav-overview"
          >
            <NavIcon icon={NAV_PAGE_ICONS.overview} />
            {t("editor.navTitle.overview")}
          </OrgNavLink>
        )}
        {isMemberOrg && activeOrgId != null && <>
          <OrgNavLink to={orgPath(activeOrgId, "/teams")} className={link}>
            <NavIcon icon={NAV_PAGE_ICONS.teams} />
            {t("editor.navTitle.teams")}
          </OrgNavLink>
          <OrgNavLink to={orgPath(activeOrgId, "/assigned")} className={link} data-tour="nav-assigned">
            <NavIcon icon={NAV_PAGE_ICONS.assigned} />
            {t("editor.navTitle.assignedToMe")}
          </OrgNavLink>
        </>}
        {isAdmin && activeOrgId != null && <>
          <div className="my-1 border-t" />
          <OrgNavLink to={orgPath(activeOrgId, "/members")} className={link}>
            <NavIcon icon={NAV_PAGE_ICONS.members} />
            {t("editor.navTitle.members")}
          </OrgNavLink>
          <OrgNavLink to={orgPath(activeOrgId, "/archived")} className={link}>
            <NavIcon icon={NAV_PAGE_ICONS.archived} />
            {t("org.orgSidebar.archived")}
          </OrgNavLink>
          <OrgNavLink to={orgPath(activeOrgId, "/settings")} className={link} data-tour="nav-settings">
            <NavIcon icon={NAV_PAGE_ICONS.settings} />
            {t("nav.settings")}
          </OrgNavLink>
        </>}
        {isPlatformAdmin && <>
          <div className="my-1 border-t" />
          <OrgNavLink to="/admin" className={link}>
            <NavIcon icon={NAV_PAGE_ICONS.admin} />
            {t("org.orgSidebar.admin")}
          </OrgNavLink>
        </>}
        {hasSharedProjects && (
          <>
            <div className="my-1 border-t" />
            <OrgNavLink to="/shared" className={link}>
              <NavIcon icon={NAV_PAGE_ICONS.shared} />
              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                {t("editor.navTitle.sharedWithYou")}
                {hasNewSharedProjects && (
                  <Badge className="shrink-0" data-testid="new-shared-nav-badge">
                    {t("org.guestOrgHome.newBadge")}
                  </Badge>
                )}
              </span>
            </OrgNavLink>
          </>
        )}
      </nav>
      <div className="mt-auto pt-2" data-tour="account-switcher">
        <div className="min-w-0">
          <AccountSwitcher variant="sidebar" />
        </div>
      </div>
    </div>
  )
}
