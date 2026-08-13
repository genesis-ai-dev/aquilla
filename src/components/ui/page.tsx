import * as React from "react"

import { EmptyState } from "@/components/ui/empty"
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
 * - Radius is `rounded-lg` to match the canonical Card primitive (card.tsx)
 *   and the app `--radius` token used by controls/popovers.
 * - Headings use `font-heading` (matching CardTitle) and lean on weight +
 *   color for hierarchy rather than oversized type.
 */

type PageSize = "default" | "wide" | "full"

/**
 * The scroll container + content well for a page rendered inside AppShell's
 * `main`. Replaces the repeated
 * `<div className="h-full overflow-y-auto"><div className="p-6">` boilerplate.
 *
 * - `default` (max-w-2xl, mx-auto): forms & settings — centered, fills up to
 *   max width. No page insets; headers carry their own left padding.
 * - `wide` (max-w-6xl, mx-auto): list/grid surfaces (Overview, Members, Teams).
 * - `full`: no max width, for surfaces that manage their own width.
 *
 * Vertical rhythm: page pad (`py-18`) is 1.5× the section stack gap (`gap-12` /
 * `space-y-12`). PageHeader's bottom margin matches that same section gap.
 * AppShell keeps the floating card flush under the header so the card's top
 * edge still lines up with the org switcher despite this inner pad.
 *
 * `scrollbar-gutter: stable` reserves the scrollbar lane so centered
 * `max-w-*` columns (org / project / team settings, Preferences, …) do not
 * nudge horizontally when overflow appears or disappears between panes.
 */
function Page({
  size = "default",
  className,
  children,
  ...props
}: {
  size?: PageSize
  className?: string
  children: React.ReactNode
} & Omit<React.ComponentProps<"div">, "children" | "className">) {
  return (
    <div className="h-full overflow-y-auto scrollbar-gutter-stable" {...props}>
      <div
        className={cn(
          "mx-auto w-full py-18",
          size === "default" && "max-w-2xl",
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
 *
 * `inset` (default true) left-pads the title to align with text inside
 * settings cards (`SettingsGroup` / `SettingsRow`). Table / list surfaces
 * (`Page size="wide"`) pass `inset={false}` so the title flushes with the
 * table edge instead of looking like a settings page.
 *
 * Bottom margin matches the section stack gap (`gap-12`); zero it when the
 * header sits inside a `space-y-12` / `gap-12` parent so the gap isn't doubled.
 */
function PageHeader({
  title,
  description,
  actions,
  inset = true,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  /** Align with settings-card text padding. Off for table / list pages. */
  inset?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "mb-12 flex items-start justify-between gap-4",
        inset && "pl-4",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className={cn("flex shrink-0 items-center gap-2", inset && "pr-4")}>
          {actions}
        </div>
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
  headerClassName,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  footer?: React.ReactNode
  contentClassName?: string
  headerClassName?: string
}) {
  const hasHeader = Boolean(title || description || action)
  return (
    <section
      className={cn("overflow-hidden rounded-lg border bg-card", className)}
      {...props}
    >
      {hasHeader ? (
        <div
          className={cn(
            "flex items-start justify-between gap-4 px-5 pt-5 pb-4",
            headerClassName,
          )}
        >
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
    <div className={cn("rounded-lg border bg-card px-5 py-4", className)}>
      <div className="text-2xl leading-none font-semibold tracking-normal tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-1.5 text-sm text-muted-foreground">{label}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

/**
 * A labelled settings block: a floating group header (same weight as NavList's
 * group label) above a bordered card. Use on detail sub-pages so the page title
 * lives in PageHeader and only the controls sit in the card — matching the
 * Linear-style settings layout.
 */
function SettingsGroup({
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
        <p className="pl-4 font-heading text-base font-medium tracking-tight text-foreground">
          {label}
        </p>
      ) : null}
      <div className="divide-y overflow-hidden rounded-lg border bg-card">
        {children}
      </div>
    </div>
  )
}

/**
 * One setting inside a SettingsGroup card. Default layout is label/description
 * on the left and a control on the right; pass `block` (or `children`) when the
 * control needs the full row width (a select, a form, etc.).
 */
function SettingsRow({
  label,
  description,
  control,
  children,
  block = false,
  className,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  control?: React.ReactNode
  children?: React.ReactNode
  block?: boolean
  className?: string
}) {
  const body = children ?? control
  if (block || children) {
    return (
      <div className={cn("space-y-3 px-4 py-3", className)}>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {body}
      </div>
    )
  }
  return (
    <div className={cn("flex items-center justify-between gap-4 px-4 py-3", className)}>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {body ? <div className="shrink-0">{body}</div> : null}
    </div>
  )
}

export { Page, PageHeader, Section, SettingsGroup, SettingsRow, StatTile, EmptyState }
