import * as React from "react"
import { Link } from "react-router-dom"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Navigation rows for index / hub surfaces (Settings, Preferences). Instead of
 * dropping every form onto one page, these pages list their sections as large,
 * tappable rows — a leading icon tile, a title, an optional right-aligned hint
 * (a count or the current value, e.g. "System", "12", "Maintainer"), and a
 * chevron — that navigate into a focused detail sub-page. Same visual family as
 * the Section primitive in page.tsx: one bordered, rounded-2xl card with the
 * border carrying the separation in both light and dark themes.
 */

/**
 * A group of NavRows in a single bordered card, with an optional uppercase
 * group label above it (like Linear's settings groupings).
 */
function NavList({
  label,
  className,
  children,
}: {
  label?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {label ? (
        <p className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </p>
      ) : null}
      <div className="divide-y overflow-hidden rounded-2xl border bg-card">
        {children}
      </div>
    </div>
  )
}

/**
 * A single navigation row. `hint` sits to the right of the title (truncated so
 * a long value never crowds out the title) with a chevron trailing it.
 */
function NavRow({
  to,
  icon: Icon,
  title,
  description,
  hint,
  className,
}: {
  to: string
  icon?: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  description?: React.ReactNode
  hint?: React.ReactNode
  className?: string
}) {
  return (
    <Link
      to={to}
      className={cn(
        "group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
        className,
      )}
    >
      {Icon ? (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground transition-colors group-hover:text-foreground">
          <Icon className="size-5" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {description ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {hint ? (
        <span className="max-w-[45%] shrink-0 truncate text-sm text-muted-foreground tabular-nums">
          {hint}
        </span>
      ) : null}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

/**
 * A small "back to the index" link for the top-left of a detail/submenu page.
 * Pairs with the section card's own title below it, so a submenu page reads as
 * "‹ Settings" then the section heading — self-sufficient navigation inside the
 * main area without relying on the header breadcrumb.
 */
function BackLink({
  to,
  label,
  className,
}: {
  to: string
  label: React.ReactNode
  className?: string
}) {
  return (
    <Link
      to={to}
      className={cn(
        "group -ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      <ChevronLeft className="size-4 transition-transform group-hover:-translate-x-0.5" />
      {label}
    </Link>
  )
}

export { NavList, NavRow, BackLink }
