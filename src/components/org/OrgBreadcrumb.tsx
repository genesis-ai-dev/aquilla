import { Link, useLocation } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"

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
  const labelClass = crumb.isRoot
    ? "block shrink-0 whitespace-nowrap rounded-md px-1.5 py-1"
    : "block max-w-[clamp(7rem,20vw,18rem)] truncate rounded-md px-1.5 py-1"
  if (crumb.isCurrent) {
    return <BreadcrumbPage className={labelClass} title={crumb.label}>{crumb.label}</BreadcrumbPage>
  }
  if (crumb.to) {
    return (
      <BreadcrumbLink
        className={`${labelClass} hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
        render={<Link to={crumb.to} />}
        onClick={crumb.onClick}
        title={crumb.label}
      >
        {crumb.label}
      </BreadcrumbLink>
    )
  }
  if (crumb.onClick) {
    return (
      <BreadcrumbLink
        className={`${labelClass} hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
        render={<button type="button" />}
        onClick={crumb.onClick}
        title={crumb.label}
      >
        {crumb.label}
      </BreadcrumbLink>
    )
  }
  return <span className="font-normal text-foreground">{crumb.label}</span>
}

function CrumbSeparator() {
  return (
    <BreadcrumbSeparator>
      <span className="text-muted-foreground">›</span>
    </BreadcrumbSeparator>
  )
}

function renderCrumbItem(crumb: Crumb, key: string) {
  return (
    <BreadcrumbItem key={key} className={crumb.isRoot ? "shrink-0" : "min-w-0"}>
      <CrumbLink crumb={crumb} />
    </BreadcrumbItem>
  )
}

export function OrgBreadcrumb({ parent, section, sectionTo, orgId, trail = [] }: OrgBreadcrumbProps) {
  const { activeOrgId, isAllOrgs, orgs, setActiveOrg, setAllOrgs } = useActiveOrg()
  const location = useLocation()
  const showSection = section !== "Projects" || parent != null
  const resolvedOrgId = orgId ?? (!isAllOrgs ? activeOrgId : null)
  const resolvedOrg = resolvedOrgId == null ? null : orgs.find((org) => org.id === resolvedOrgId) ?? null
  const isRootLanding = location.pathname === "/" && !showSection && resolvedOrg == null
  const isOrgLanding = location.pathname === "/" && !showSection && resolvedOrg != null

  function handleAllOrgs() {
    setAllOrgs()
  }

  const crumbs: Crumb[] = [{
    label: "All organizations",
    to: isRootLanding ? undefined : "/?org=all",
    onClick: isRootLanding ? undefined : handleAllOrgs,
    isCurrent: isRootLanding,
    isRoot: true,
  }]

  if (resolvedOrg) {
    crumbs.push({
      label: resolvedOrg.name ?? "Organization",
      to: isOrgLanding ? undefined : `/?org=${resolvedOrg.id}`,
      onClick: isOrgLanding ? undefined : () => setActiveOrg(resolvedOrg.id),
      isCurrent: isOrgLanding,
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

  return (
    <Breadcrumb className="min-w-0 overflow-hidden px-3">
      <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden whitespace-nowrap">{items}</BreadcrumbList>
    </Breadcrumb>
  )
}
