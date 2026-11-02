import * as React from "react"

import { EmptyState, NotFoundIcon, TableEmptyState } from "@/components/ui/empty"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { LockedNote, LockedSection } from "@/components/ui/locked-note"
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
 *   max width. Horizontal pad lives on the scroll shell so the column never
 *   kisses the AppShell card; headers still carry their own left padding to
 *   align with settings-card text.
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
  fill = false,
  className,
  children,
  ...props
}: {
  size?: PageSize
  /**
   * Pin the page well to the AppShell card and let a `fillHeight` DataTable
   * (or other flex-1 child) own remaining height — used by directory lists.
   */
  fill?: boolean
  className?: string
  children: React.ReactNode
} & Omit<React.ComponentProps<"div">, "children" | "className">) {
  return (
    <div
      className={cn(
        "h-full px-6 scrollbar-gutter-stable",
        fill ? "flex min-h-0 flex-col overflow-hidden" : "overflow-y-auto",
      )}
      {...props}
    >
      <div
        className={cn(
          "mx-auto w-full",
          fill ? "flex min-h-0 flex-1 flex-col py-18" : "py-18",
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
  titleClassName,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  footer?: React.ReactNode
  contentClassName?: string
  headerClassName?: string
  /** Restyle this card's own title — e.g. to match a host page's heading scale. */
  titleClassName?: string
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
              <h2
                className={cn(
                  "font-heading text-base leading-snug font-medium text-foreground",
                  titleClassName,
                )}
              >
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
 * Stat-tile strip: 1-up (single-row cards) only on the narrowest screens,
 * 2-up from 480px so that step lasts through large phones, 3-up from `md`,
 * 6-up on wide. Pair with `StatTile` (and matching loading skeletons).
 */
const STAT_TILE_GRID =
  "grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-6"

/**
 * A single at-a-glance metric. Numbers use tabular-nums so columns of figures
 * line up and don't jitter as values change.
 *
 * Below 480px the tile is a single row (label left, value right). From 480px
 * it stacks value-on-top with the 2-up / 3-up / 6-up grid.
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
    <div
      className={cn(
        "flex min-h-[88px] flex-row-reverse items-center justify-between gap-4 rounded-lg border bg-card px-5 py-4",
        "min-[480px]:flex-col min-[480px]:items-start min-[480px]:justify-start min-[480px]:gap-0",
        className,
      )}
    >
      <div className="text-2xl leading-none font-semibold tracking-normal tabular-nums text-foreground">
        {value}
      </div>
      <div className="min-w-0">
        <div className="text-sm text-muted-foreground min-[480px]:mt-1.5">{label}</div>
        {hint ? (
          <div className="mt-0.5 text-xs text-muted-foreground min-[480px]:mt-1">{hint}</div>
        ) : null}
      </div>
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
  description,
  locked,
  className,
  children,
}: {
  label?: React.ReactNode
  description?: React.ReactNode
  /** Why the whole card is locked for you (AQU-2260): one line under its
   *  heading. Controls inside given this same reason say nothing more; one
   *  locked for another reason still says its own. Null when you can edit. */
  locked?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {label || description || locked ? (
        <div className="space-y-1 pl-4">
          {label ? (
            <p className="font-heading text-base font-medium tracking-tight text-foreground">
              {label}
            </p>
          ) : null}
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
          {locked ? (
            <LockedNote placement="section" testId="settings-group-locked">
              {locked}
            </LockedNote>
          ) : null}
        </div>
      ) : null}
      <div data-slot="settings-card" className="divide-y overflow-hidden rounded-lg border bg-card">
        <LockedSection reason={locked}>{children}</LockedSection>
      </div>
    </div>
  )
}

/** The longer explanation a SettingsRow keeps behind an (i) beside its title. */
interface SettingsRowInfo {
  /** The (i)'s accessible name: a few words saying what the text is about. */
  label: string
  /** What opens under the row's one visible line. */
  content: React.ReactNode
  /** Names the (i) `testId` and its text `${testId}-text`. */
  testId?: string
}

/**
 * One setting inside a SettingsGroup card. Default layout is label/description
 * on the left and a control on the right; pass `block` (or `children`) when the
 * control needs the full row width (a select, a form, etc.).
 *
 * Sam, Oct 29: a setting shows one short line saying what it does, or none
 * when its title already says it. Anything longer goes in `info`: an (i)
 * beside the title opens it in place beneath that line, and closes it again.
 */
function SettingsRow({
  label,
  description,
  info,
  control,
  children,
  block = false,
  className,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  info?: SettingsRowInfo
  control?: React.ReactNode
  children?: React.ReactNode
  block?: boolean
  className?: string
}) {
  const infoId = React.useId()
  const [infoOpen, toggleInfo] = useInfoOpen()
  const body = children ?? control
  const text = (
    <>
      <p className="flex items-center gap-1 text-sm font-medium text-foreground">
        {label}
        {info ? (
          <InfoToggle
            open={infoOpen}
            onToggle={toggleInfo}
            label={info.label}
            controls={infoId}
            testId={info.testId}
          />
        ) : null}
      </p>
      {description ? (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      ) : null}
      {info ? (
        <InfoReveal
          open={infoOpen}
          id={infoId}
          testId={info.testId ? `${info.testId}-text` : undefined}
          className="text-xs text-muted-foreground"
        >
          {info.content}
        </InfoReveal>
      ) : null}
    </>
  )
  if (block || children) {
    return (
      <div className={cn("space-y-3 px-4 py-3", className)}>
        <div className="min-w-0">{text}</div>
        {body}
      </div>
    )
  }
  // AQU-1768: the control sits at the top, level with the label, not centred.
  // A description can grow while the page is open (a "N projects set their
  // own setting" list opening under it), and a centred control slid down to
  // the new middle each time.
  // Sam, Oct 29: the text takes the whole width up to the control.
  return (
    <div className={cn("flex items-start justify-between gap-4 px-4 py-3", className)}>
      <div className="min-w-0 flex-1">{text}</div>
      {body ? <div className="shrink-0">{body}</div> : null}
    </div>
  )
}

/**
 * Free-form content inside a SettingsGroup card: a paragraph, a tab strip, a
 * standalone control. The card itself has no padding — only its rows supply the
 * inset — so content dropped straight into it starts at the border, to the left
 * of its own heading and of the rows around it (AQU-1524). Wrap it in this and
 * it shares SettingsRow's inset and clears the card's dividers.
 */
function SettingsBlock({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="settings-block"
      className={cn("px-4 py-3", className)}
      {...props}
    />
  )
}

export { Page, PageHeader, Section, SettingsGroup, SettingsRow, SettingsBlock, StatTile, STAT_TILE_GRID, EmptyState, NotFoundIcon, TableEmptyState }
