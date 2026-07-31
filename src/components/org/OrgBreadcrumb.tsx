import { useCallback, useEffect, useRef, useState } from "react"
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
import { cn } from "@/lib/utils"

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

const SCROLL_EDGE_EPS = 1

/** Solid edge fades — same approach as TabStrip against sidebar chrome. */
const STRIP_EDGE_FADE =
  "pointer-events-none absolute inset-y-0 z-20 w-8 transition-opacity duration-150"

function CrumbLink({ crumb }: { crumb: Crumb }) {
  // Keep crumbs at natural width so the trail scrolls instead of truncating
  // away segments on narrow headers.
  const labelClass = "block shrink-0 cursor-default whitespace-nowrap rounded-md px-1.5 py-1"
  // Tooltip still helps when a long label is partially under an edge fade.
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
  const { activeOrgId, isAllOrgs, orgs, setActiveOrg, setAllOrgs } = useActiveOrg()
  const location = useLocation()
  const scrollRef = useRef<HTMLOListElement | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const showSection = section !== "Projects" || parent != null
  const resolvedOrgId = orgId ?? (!isAllOrgs ? activeOrgId : null)
  const resolvedOrg = resolvedOrgId == null ? null : orgs.find((org) => org.id === resolvedOrgId) ?? null
  const parsed = parseOrgPath(location.pathname)
  const isRootLanding =
    parsed?.orgKey === ALL_ORGS_PARAM && !showSection && resolvedOrg == null
  const isOrgLanding =
    typeof parsed?.orgKey === "number" &&
    parsed.rest === "" &&
    !showSection &&
    resolvedOrg != null &&
    parsed.orgKey === resolvedOrg.id

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

  const updateScrollEdges = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    setCanScrollLeft(scrollLeft > SCROLL_EDGE_EPS)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - SCROLL_EDGE_EPS)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Prefer the current (trailing) crumb when the trail overflows.
    el.scrollLeft = el.scrollWidth
    updateScrollEdges()
    const ro = new ResizeObserver(updateScrollEdges)
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateScrollEdges, crumbKey])

  return (
    <Breadcrumb className="relative min-w-0 px-3">
      <BreadcrumbList
        ref={scrollRef}
        onScroll={updateScrollEdges}
        className="min-w-0 flex-nowrap overflow-x-auto overscroll-x-contain whitespace-nowrap scrollbar-none"
      >
        {items}
      </BreadcrumbList>
      <span
        aria-hidden
        className={cn(
          STRIP_EDGE_FADE,
          "left-0 bg-linear-to-r from-sidebar from-30% to-transparent",
          canScrollLeft ? "opacity-100" : "opacity-0",
        )}
      />
      <span
        aria-hidden
        className={cn(
          STRIP_EDGE_FADE,
          "right-0 bg-linear-to-l from-sidebar from-30% to-transparent",
          canScrollRight ? "opacity-100" : "opacity-0",
        )}
      />
    </Breadcrumb>
  )
}
