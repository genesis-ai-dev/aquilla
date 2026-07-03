import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Shared page-composition primitives for the org and account surfaces
 * (Overview, Teams, Members, Settings, Preferences). These exist to make those
 * surfaces feel deliberate and consistent: one page container, one header
 * shape, one section/card treatment, one stat tile, one empty state — instead
 * of each page hand-rolling its own spacing, radius, and headings.
 *
 * Design notes (see docs/swarm/DESIGN-LANGUAGE.md):
 * - Sections carry an explicit `border` because in dark mode --card, --surface,
 *   and --background resolve to the SAME color, so a borderless bg-card surface
 *   is invisible on these pages. The border is the separator in both themes.
 * - Radius is `rounded-2xl` to match the canonical Card primitive (card.tsx),
 *   not the tighter `rounded-lg` the old hand-rolled sections used.
 * - Headings use `font-heading` (matching CardTitle) and lean on weight +
 *   color for hierarchy rather than oversized type.
 */

type PageSize = "default" | "wide" | "full"

/**
 * The scroll container + centered, width-constrained content well for a page
 * rendered inside AppShell's `main`. Replaces the repeated
 * `<div className="h-full overflow-y-auto"><div className="p-6">` boilerplate.
 *
 * - `default` (max-w-3xl): forms & settings — narrower reads as more intentional.
 * - `wide` (max-w-6xl): list/grid surfaces (Overview, Members, Teams).
 * - `full`: no max width, for surfaces that manage their own width.
 */
function Page({
  size = "default",
  className,
  children,
}: {
  size?: PageSize
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          "mx-auto w-full px-4 py-6 sm:px-6 sm:py-8",
          size === "default" && "max-w-3xl",
          size === "wide" && "max-w-6xl",
          size === "full" && "max-w-none",
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * Page-level heading: title + optional description + optional actions. The one
 * shape every surface opens with, so the eye lands in the same place each time.
 */
function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("mb-6 flex items-start justify-between gap-4 sm:mb-8", className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}

/**
 * A titled content card. Header (title/description/action) is optional so the
 * same primitive works for a labelled settings block or a bare container.
 * An optional `footer` renders a muted, bordered strip (e.g. for save actions),
 * mirroring CardFooter.
 */
function Section({
  title,
  description,
  action,
  footer,
  className,
  contentClassName,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  footer?: React.ReactNode
  contentClassName?: string
}) {
  const hasHeader = Boolean(title || description || action)
  return (
    <section
      className={cn("overflow-hidden rounded-2xl border bg-card", className)}
      {...props}
    >
      {hasHeader ? (
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-4">
          <div className="min-w-0 space-y-1">
            {title ? (
              <h2 className="font-heading text-base leading-snug font-medium text-foreground">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className={cn("px-5 pb-5", !hasHeader && "pt-5", contentClassName)}>
        {children}
      </div>
      {footer ? (
        <div className="flex items-center gap-3 border-t bg-muted/30 px-5 py-3">
          {footer}
        </div>
      ) : null}
    </section>
  )
}

/**
 * A single at-a-glance metric. Numbers use tabular-nums so columns of figures
 * line up and don't jitter as values change.
 */
function StatTile({
  label,
  value,
  hint,
  className,
}: {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("rounded-2xl border bg-card px-5 py-4", className)}>
      <div className="text-2xl leading-none font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-1.5 text-sm text-muted-foreground">{label}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

/**
 * A composed empty state — a beat of guidance instead of a blank panel.
 * Dashed border distinguishes "nothing here yet" from a populated Section.
 */
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed bg-card/40 px-6 py-12 text-center",
        className,
      )}
    >
      {Icon ? (
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </div>
      ) : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export { Page, PageHeader, Section, StatTile, EmptyState }
