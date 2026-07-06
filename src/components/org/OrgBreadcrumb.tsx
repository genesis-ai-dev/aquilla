import type { ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { useActiveOrg } from "@/context/OrgContext"
import { Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { isOrgScopedRoute } from "./org-route-scope"

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
  /**
   * Project workspace layout: org segments (when present) collapse into a
   * leading ellipsis menu; section + trail stay visible.
   */
  workspace?: boolean
  /** Segments after section (e.g. open file, current book/chapter). Last is current page. */
  trail?: OrgBreadcrumbTrailSegment[]
}

interface Crumb {
  label: string
  onClick?: () => void
  to?: string
  isCurrent?: boolean
}

function CrumbLink({ crumb }: { crumb: Crumb }) {
  if (crumb.isCurrent) {
    return <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
  }
  if (crumb.to) {
    return (
      <BreadcrumbLink render={<Link to={crumb.to} />}>{crumb.label}</BreadcrumbLink>
    )
  }
  if (crumb.onClick) {
    return (
      <BreadcrumbLink render={<button type="button" />} onClick={crumb.onClick}>
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

function EllipsisMenu({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <BreadcrumbItem>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="icon-sm" variant="ghost">
              <BreadcrumbEllipsis />
              <span className="sr-only">Show breadcrumb path</span>
            </Button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuGroup>
            {crumbs.map((crumb) =>
              crumb.to ? (
                <DropdownMenuItem key={crumb.label} render={<Link to={crumb.to} />}>
                  {crumb.label}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={crumb.label} onClick={crumb.onClick}>
                  {crumb.label}
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </BreadcrumbItem>
  )
}

function renderCrumbItem(crumb: Crumb, key: string) {
  return (
    <BreadcrumbItem key={key}>
      <CrumbLink crumb={crumb} />
    </BreadcrumbItem>
  )
}

export function OrgBreadcrumb({ parent, section, sectionTo, workspace, trail = [] }: OrgBreadcrumbProps) {
  const { activeOrg, activeOrgId, isAllOrgs, orgs, setAllOrgs } = useActiveOrg()
  const location = useLocation()
  const navigate = useNavigate()
  const orgLabel = isAllOrgs ? "All organizations" : (activeOrg?.name ?? "Workspace")
  const canNavigateToOrg = !workspace && !isAllOrgs && activeOrgId != null && section !== "Projects"
  const showSection = section !== "Projects" || parent != null

  function handleAllOrgs() {
    setAllOrgs()
    if (isOrgScopedRoute(location.pathname) || location.pathname === "/") {
      navigate({ pathname: "/", search: "?org=all" })
    }
  }

  function handleOrg() {
    if (!canNavigateToOrg) return
    navigate({ pathname: "/", search: `?org=${activeOrgId}` })
  }

  const tailCrumbs: Crumb[] = []

  if (parent) {
    tailCrumbs.push({ label: parent.label, to: parent.to })
  }

  if (showSection) {
    tailCrumbs.push({
      label: section,
      to: sectionTo,
      isCurrent: !sectionTo && trail.length === 0,
    })
  }

  trail.forEach((segment, index) => {
    const isLast = index === trail.length - 1
    tailCrumbs.push({
      label: segment.label,
      to: segment.to,
      onClick: segment.onClick,
      isCurrent: isLast && !segment.to && !segment.onClick,
    })
  })

  if (workspace) {
    const orgCrumbs: Crumb[] = []
    if (orgs.length > 1 && !isAllOrgs) {
      orgCrumbs.push({ label: "All organizations", onClick: handleAllOrgs })
    }
    if (!isAllOrgs && activeOrg) {
      orgCrumbs.push({
        label: activeOrg.name ?? "Workspace",
        onClick: () => navigate({ pathname: "/", search: `?org=${activeOrgId}` }),
      })
    }

    if (tailCrumbs.length === 0) return null

    const items: ReactNode[] = []
    let sep = 0
    if (orgCrumbs.length > 0) {
      items.push(<EllipsisMenu key="ellipsis" crumbs={orgCrumbs} />)
      items.push(<CrumbSeparator key={`sep-${sep++}`} />)
    }
    tailCrumbs.forEach((crumb, index) => {
      if (index > 0) items.push(<CrumbSeparator key={`sep-${sep++}`} />)
      items.push(renderCrumbItem(crumb, `tail-${index}`))
    })

    return (
      <Breadcrumb className="px-3 py-2">
        <BreadcrumbList>{items}</BreadcrumbList>
      </Breadcrumb>
    )
  }

  const crumbs: Crumb[] = []
  if (orgs.length > 1 && !isAllOrgs) {
    crumbs.push({ label: "All organizations", onClick: handleAllOrgs })
  }
  if (canNavigateToOrg) {
    crumbs.push({ label: orgLabel, onClick: handleOrg })
  } else {
    crumbs.push({ label: orgLabel })
  }
  crumbs.push(...tailCrumbs)

  if (crumbs.length === 0) return null

  const items: ReactNode[] = []
  crumbs.forEach((crumb, index) => {
    if (index > 0) items.push(<CrumbSeparator key={`sep-${index}`} />)
    items.push(renderCrumbItem(crumb, `${crumb.label}-${index}`))
  })

  return (
    <Breadcrumb className="px-3 py-2">
      <BreadcrumbList>{items}</BreadcrumbList>
    </Breadcrumb>
  )
}
