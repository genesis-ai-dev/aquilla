import { startTransition, type ComponentProps, type MouseEvent } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import type { LucideIcon } from "lucide-react"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin"
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
  const { activeOrg, activeOrgId, activeGuestOrg, isAllOrgs } = useActiveOrg()
  // AQU-790: in a guest org the caller has project-level access only — no org
  // membership. Member-scoped nav (Teams, Assigned, Members, Archived,
  // Settings) is hidden so nothing links into an org they can't operate on
  // (previously these rendered for the caller's *owned* active org and silently
  // switched context on click).
  const isGuestOrg = activeGuestOrg != null
  const isMemberOrg = !isAllOrgs && activeOrgId != null && !isGuestOrg
  const isAdmin = isMemberOrg && (activeOrg?.role.level ?? 0) >= 600
  // AQU-485: Members is a roster-visibility surface, not a generic admin
  // tool. Follow rosterViewMinRole so a below-floor maintainer does not see
  // the nav item, and a lowered floor can surface it for contributors.
  const { canViewRoster } = useOrgSettings(
    isMemberOrg ? activeOrgId : null,
    activeOrg?.role?.level,
  )
  const showMembersNav = isMemberOrg && canViewRoster
  // Platform-operator (site-wide admin) — separate axis from the org role.
  const { isAdmin: isPlatformAdmin } = usePlatformAdmin()

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
        {/* Guest org: Projects table only. Member: Overview + Projects. */}
        {isGuestOrg && activeOrgId != null ? (
          <OrgNavLink
            to={orgProjectsPath(activeOrgId)}
            className={link}
            data-tour="nav-projects"
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
        {isMemberOrg && activeOrgId != null && (showMembersNav || isAdmin) && (
          <div className="my-1 border-t" />
        )}
        {showMembersNav && activeOrgId != null && (
          <OrgNavLink to={orgPath(activeOrgId, "/members")} className={link}>
            <NavIcon icon={NAV_PAGE_ICONS.members} />
            {t("editor.navTitle.members")}
          </OrgNavLink>
        )}
        {isAdmin && activeOrgId != null && <>
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
          {!isAllOrgs && <div className="my-1 border-t" data-testid="platform-admin-nav-separator" />}
          <OrgNavLink to="/admin" className={link}>
            <NavIcon icon={NAV_PAGE_ICONS.admin} />
            {t("org.orgSidebar.admin")}
          </OrgNavLink>
        </>}
      </nav>
      <div className="mt-auto pt-2" data-tour="account-switcher">
        <div className="min-w-0">
          <AccountSwitcher variant="sidebar" />
        </div>
      </div>
    </div>
  )
}
