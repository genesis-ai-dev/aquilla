import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
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
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
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
  /** Collapse the trail into an inspectable location control for dense toolbars. */
  compact?: boolean
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

export function OrgBreadcrumb({ parent, section, sectionTo, orgId, trail = [], compact = false }: OrgBreadcrumbProps) {
  const { activeOrgId, isAllOrgs, orgs, guestOrgs, setActiveOrg, setAllOrgs } = useActiveOrg()
  const location = useLocation()
  const scrollRef = useRef<HTMLOListElement | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const showSection = section !== "Projects" || parent != null
  const resolvedOrgId = orgId ?? (!isAllOrgs ? activeOrgId : null)
  const resolvedOrg = resolvedOrgId == null ? null : orgs.find((org) => org.id === resolvedOrgId) ?? null
  // AQU-790: a guest org (`/orgs/:guestId`) is not a membership, so it isn't in
  // `orgs`. Resolve it from `guestOrgs` and render it as its own top-level
  // crumb — never as a descendant of one of the caller's owned orgs.
  const resolvedGuestOrg =
    resolvedOrg == null && resolvedOrgId != null
      ? guestOrgs.find((g) => g.id === resolvedOrgId) ?? null
      : null
  const parsed = parseOrgPath(location.pathname)
  const isRootLanding =
    parsed?.orgKey === ALL_ORGS_PARAM && !showSection && resolvedOrg == null && resolvedGuestOrg == null
  const isOrgLanding =
    typeof parsed?.orgKey === "number" &&
    parsed.rest === "" &&
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
  const pathLabel = crumbs.map((crumb) => crumb.label).join(" › ")

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

  if (compact) {
    const currentLabel = crumbs.at(-1)?.label
    return (
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="Inspect workspace location"
              title={pathLabel}
              className="flex h-7 min-w-0 max-w-56 items-center gap-1.5 rounded-md px-2 text-left text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          }
        >
          <span className="min-w-0 truncate font-medium">{section}</span>
          {currentLabel && currentLabel !== section && (
            <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">· {currentLabel}</span>
          )}
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 gap-1 p-2">
          <PopoverHeader className="px-2 pb-1 pt-0.5">
            <PopoverTitle className="text-[11px] text-muted-foreground">Workspace location</PopoverTitle>
          </PopoverHeader>
          <nav aria-label="Full workspace location" className="flex flex-col gap-0.5">
            {crumbs.map((crumb, index) => {
              const className = cn(
                "flex min-h-8 items-center rounded-md px-2 text-xs outline-none",
                crumb.isCurrent
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              )
              const label = (
                <>
                  <span aria-hidden className="mr-2 w-3 text-center text-[10px] text-muted-foreground/60">
                    {index === crumbs.length - 1 ? "•" : "›"}
                  </span>
                  <span className="min-w-0 truncate">{crumb.label}</span>
                </>
              )
              if (crumb.to) {
                return <Link key={`${crumb.label}-${index}`} to={crumb.to} onClick={crumb.onClick} className={className}>{label}</Link>
              }
              if (crumb.onClick) {
                return <button key={`${crumb.label}-${index}`} type="button" onClick={crumb.onClick} className={className}>{label}</button>
              }
              return <div key={`${crumb.label}-${index}`} aria-current={crumb.isCurrent ? "page" : undefined} className={className}>{label}</div>
            })}
          </nav>
        </PopoverContent>
      </Popover>
    )
  }

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
