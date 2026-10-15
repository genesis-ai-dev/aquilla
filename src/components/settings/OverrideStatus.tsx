// AQU-1771: the line under an org default on Project defaults that says who
// follows it. Without it the page is silent in two different situations: no
// project overrides the default (so changing it asks nothing), and some do but
// the person already said "Leave unchanged" once. Both looked the same; this
// says which one it is, and keeps the reset reachable at any time instead of
// only in the moment right after a change.
//
// The Reset link does not reset by itself. It opens the section's existing
// confirmation, so there is one place that explains what a reset does.
//
// AQU-1938: "1 project is stricter than this" with no way to find out which
// one was no use to anybody. When the server names the projects, the count is
// a disclosure: clicking it lists them right under the line, each linking to
// the place that project's own value is set. The server names only projects
// the caller may see, at most 50, so the list ends "and N more" whenever the
// count covers more than it names. With no names (an older server, or none
// the caller may see) the count stays plain text, as before.
//
// Everything here renders inside SettingsRow's description <p>, so the list is
// spans with list roles rather than <ul>/<div>, which a <p> may not contain.

import { useId, useState } from "react"
import { Link } from "react-router-dom"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { OverrideProjectList } from "@/lib/sync/override-projects"
import { cn } from "@/lib/utils"

/** The app's existing inline-link look (the Reset link has always used it). */
const LINK_CLASS = "text-foreground underline underline-offset-2 hover:text-primary"

interface OverrideStatusProps {
  /** How many of the org's projects set their own value for this default. */
  count: number
  /**
   * "number" for counts (approvals needed), "setting" for switches and
   * choices, "stricter" for a setting a project may only make stricter
   * (AQU-1771: who sees the member list / each member's progress).
   */
  kind: "number" | "setting" | "stricter"
  /** Opens the section's reset confirmation. Omitted below the edit gate. */
  onReset?: () => void
  disabled?: boolean
  /**
   * The org's settings haven't loaded: the count is not known yet, so the line
   * keeps its place but says nothing (rather than "All projects follow").
   */
  loading?: boolean
  /**
   * AQU-1938: the projects behind `count`, as the server named them. Null or
   * absent keeps the count plain text.
   */
  projects?: OverrideProjectList | null
  /** AQU-1938: where a listed project's own value is set. */
  projectHref?: (projectId: string) => string
}

export function OverrideStatus({
  count, kind, onReset, disabled, loading = false, projects, projectHref,
}: OverrideStatusProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (loading) {
    return (
      <span className="invisible mt-1 block" aria-hidden="true" data-testid="override-status-loading">
        {t("settings.overrideStatus.allFollow")}
      </span>
    )
  }
  if (count <= 0) {
    return (
      <span className="mt-1 block" data-testid="override-status">
        {t("settings.overrideStatus.allFollow")}
      </span>
    )
  }
  const summary = kind === "number"
    ? t("settings.overrideStatus.someOwnNumber", { count })
    : kind === "stricter"
      ? t("settings.overrideStatus.someStricter", { count })
      : t("settings.overrideStatus.someOwnSetting", { count })
  const named = projectHref ? (projects?.projects ?? []) : []
  // The count is the headline the person reads, so "and N more" is measured
  // against it: every project it covers is either named or in that number.
  const more = Math.max(0, count - named.length)
  const listed = named.length > 0 && projectHref != null
  return (
    <span className="mt-1 block" data-testid="override-status">
      {/* Sam (2026-10-14): a stack of underlined names under an underlined
          count, a lone chevron and a dotted-on Reset "looked funny". The count
          is now a plain disclosure, Reset sits apart as the one link, and the
          projects open in a small bordered list, a row each, the way the org's
          Monday project rows read. */}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="override-status-line">
        {listed ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((was) => !was)}
          >
            {summary}
            <ChevronDown
              className={cn(
                "size-3.5 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                open && "rotate-180",
              )}
              aria-hidden
            />
          </button>
        ) : <span>{summary}</span>}
        {onReset ? (
          <button
            type="button"
            className={cn(LINK_CLASS, "disabled:no-underline disabled:opacity-60")}
            onClick={onReset}
            disabled={disabled}
          >
            {t("settings.overrideStatus.reset")}
          </button>
        ) : null}
      </span>
      {listed ? (
        // Always drawn, so it can open and close smoothly (the same grid-rows
        // move as the Team card's "Visibility adjusted" note); hidden from
        // reading and from Tab while it is shut.
        <span
          className={cn(
            "grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none",
            open ? "mt-2 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
          aria-hidden={!open}
          inert={!open || undefined}
        >
          <span className="min-h-0 overflow-hidden">
            <span
              id={listId}
              role="list"
              className="block max-w-sm divide-y divide-border overflow-hidden rounded-md border bg-background"
              data-testid="override-status-projects"
            >
              {named.map((project) => (
                <span key={project.id} role="listitem" className="block">
                  <Link
                    to={projectHref(project.id)}
                    className="flex items-center justify-between gap-3 px-3 py-1.5 text-foreground hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                  >
                    <span className="min-w-0 truncate">{project.name}</span>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </span>
              ))}
              {more > 0 ? (
                <span role="listitem" className="block px-3 py-1.5 text-muted-foreground">
                  {t("settings.overrideStatus.andMore", { count: more })}
                </span>
              ) : null}
            </span>
          </span>
        </span>
      ) : null}
    </span>
  )
}
