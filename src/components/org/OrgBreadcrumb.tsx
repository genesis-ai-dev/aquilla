import { useEffect, useRef } from "react"
import { Link, useLocation } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import { ALL_ORGS_PARAM, orgHomePath, parseOrgPath } from "@/lib/navigation/org-paths"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { AppTooltip } from "@/components/ui/tooltip"

interface OrgBreadcrumbParent {
  label: string
  to: string
}

export interface OrgBreadcrumbTrailSegment {
  label: string
  to?: string
  onClick?: () => void
}

interface OrgBreadcrumbProps {
  parent?: OrgBreadcrumbParent
  section: string
  /** When set, the section label is a link (e.g. project name → overview). */
  sectionTo?: string
  /** Owning organization for project routes, which may not match the dashboard filter. */
  orgId?: number | null
  /** Segments after section (e.g. open file, current book/chapter). Last is current page. */
  trail?: OrgBreadcrumbTrailSegment[]
}

interface Crumb {
  label: string
  onClick?: () => void
  to?: string
  isCurrent?: boolean
  isRoot?: boolean
}

function CrumbLink({ crumb }: { crumb: Crumb }) {
  // Keep crumbs at natural width so the trail scrolls instead of truncating
  // away segments on narrow headers.
  const labelClass = "block shrink-0 cursor-default whitespace-nowrap rounded-md px-1.5 py-1"
  // Tooltip still helps when a long label is partially under a scroll fade.
  if (crumb.isCurrent) {
    return (
      <AppTooltip content={crumb.label}>
        <BreadcrumbPage className={labelClass}>{crumb.label}</BreadcrumbPage>
      </AppTooltip>
    )
  }
  if (crumb.to) {
    return (
      <AppTooltip content={crumb.label}>
        <BreadcrumbLink
          className={`${labelClass} hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
          render={<Link to={crumb.to} />}
          onClick={crumb.onClick}
        >
          {crumb.label}
        </BreadcrumbLink>
      </AppTooltip>
    )
  }
  if (crumb.onClick) {
    return (
      <AppTooltip content={crumb.label}>
        <BreadcrumbLink
          className={`${labelClass} hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
          render={<button type="button" />}
          onClick={crumb.onClick}
        >
          {crumb.label}
        </BreadcrumbLink>
      </AppTooltip>
    )
  }
  return <span className="font-normal text-foreground">{crumb.label}</span>
}

function CrumbSeparator() {
  return (
    <BreadcrumbSeparator className="shrink-0">
      <span className="text-muted-foreground">›</span>
    </BreadcrumbSeparator>
  )
}

function renderCrumbItem(crumb: Crumb, key: string) {
  return (
    <BreadcrumbItem key={key} className="shrink-0">
      <CrumbLink crumb={crumb} />
    </BreadcrumbItem>
  )
}

export function OrgBreadcrumb({ parent, section, sectionTo, orgId, trail = [] }: OrgBreadcrumbProps) {
  const { activeOrgId, isAllOrgs, orgs, guestOrgs, setActiveOrg, setAllOrgs } = useActiveOrg()
  const location = useLocation()
  const scrollRef = useRef<HTMLOListElement | null>(null)
  const parsed = parseOrgPath(location.pathname)
  // "Overview" is the member-org landing (`/overview`): omit the trailing
  // section crumb so the org name is current.
  // "Projects" used to be the org index and was hidden the same way; now the
  // dedicated `/orgs/:id/projects` page shows it (Teams-style). Portfolio
  // (`/orgs/all`) and guest-org index still omit the redundant section crumb.
  const isOverviewSection = section === "Overview"
  const isMemberOrgProjectsPage =
    section === "Projects" &&
    typeof parsed?.orgKey === "number" &&
    parsed.rest === "/projects"
  const showSection =
    parent != null ||
    isMemberOrgProjectsPage ||
    (section !== "Projects" && !isOverviewSection)
  const resolvedOrgId = orgId ?? (!isAllOrgs ? activeOrgId : null)
  const resolvedOrg = resolvedOrgId == null ? null : orgs.find((org) => org.id === resolvedOrgId) ?? null
  // AQU-790: a guest org (`/orgs/:guestId`) is not a membership, so it isn't in
  // `orgs`. Resolve it from `guestOrgs` and render it as its own top-level
  // crumb — never as a descendant of one of the caller's owned orgs.
  const resolvedGuestOrg =
    resolvedOrg == null && resolvedOrgId != null
      ? guestOrgs.find((g) => g.id === resolvedOrgId) ?? null
      : null
  const isRootLanding =
    parsed?.orgKey === ALL_ORGS_PARAM && !showSection && resolvedOrg == null && resolvedGuestOrg == null
  // Member org "home" is `/overview` (or bare index redirecting there).
  const isOrgLanding =
    typeof parsed?.orgKey === "number" &&
    (parsed.rest === "" || parsed.rest === "/overview") &&
    !showSection &&
    resolvedOrg != null &&
    parsed.orgKey === resolvedOrg.id
  const isGuestOrgLanding =
    typeof parsed?.orgKey === "number" &&
    parsed.rest === "" &&
    !showSection &&
    resolvedGuestOrg != null &&
    parsed.orgKey === resolvedGuestOrg.id

  function handleAllOrgs() {
    setAllOrgs()
  }

  const crumbs: Crumb[] = [{
    label: "All organizations",
    to: isRootLanding ? undefined : orgHomePath(ALL_ORGS_PARAM),
    onClick: isRootLanding ? undefined : handleAllOrgs,
    isCurrent: isRootLanding,
    isRoot: true,
  }]

  if (resolvedOrg) {
    crumbs.push({
      label: resolvedOrg.name ?? "Organization",
      to: isOrgLanding ? undefined : orgHomePath(resolvedOrg.id),
      onClick: isOrgLanding ? undefined : () => setActiveOrg(resolvedOrg.id),
      isCurrent: isOrgLanding,
    })
  } else if (resolvedGuestOrg) {
    // AQU-790: link only (no setActiveOrg onClick) — the path drives the guest
    // scope; navigation keeps it a sibling of "All organizations".
    crumbs.push({
      label: resolvedGuestOrg.name ?? "Organization",
      to: isGuestOrgLanding ? undefined : orgHomePath(resolvedGuestOrg.id),
      isCurrent: isGuestOrgLanding,
    })
  }

  if (parent) {
    crumbs.push({ label: parent.label, to: parent.to })
  }

  if (showSection) {
    crumbs.push({
      label: section,
      to: sectionTo,
      isCurrent: !sectionTo && trail.length === 0,
    })
  }

  trail.forEach((segment, index) => {
    const isLast = index === trail.length - 1
    crumbs.push({
      label: segment.label,
      to: segment.to,
      onClick: segment.onClick,
      isCurrent: isLast && !segment.to && !segment.onClick,
    })
  })

  const items: Array<ReturnType<typeof renderCrumbItem> | ReturnType<typeof CrumbSeparator>> = []
  crumbs.forEach((crumb, index) => {
    if (index > 0) items.push(<CrumbSeparator key={`sep-${index}`} />)
    items.push(renderCrumbItem(crumb, `${crumb.label}-${index}`))
  })

  // Stable key so parent re-renders with a fresh `trail` array don't reset scroll.
  const crumbKey = crumbs.map((crumb) => crumb.label).join("\0")

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Prefer the current (trailing) crumb when the trail overflows.
    el.scrollLeft = el.scrollWidth
  }, [crumbKey])

  return (
    <Breadcrumb className="min-w-0 px-3">
      <BreadcrumbList
        ref={scrollRef}
        className="min-w-0 scroll-fade-x scroll-fade-8 flex-nowrap overflow-x-auto overscroll-x-contain whitespace-nowrap scrollbar-none"
      >
        {items}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
