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
import { ChevronDown } from "lucide-react"
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
  return (
    <span className="mt-1 block" data-testid="override-status">
      {named.length > 0 ? (
        <button
          type="button"
          className={cn("inline-flex items-center gap-0.5", LINK_CLASS)}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => setOpen((was) => !was)}
        >
          {summary}
          <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      ) : summary}
      {onReset ? (
        <>
          {" · "}
          <button
            type="button"
            className={cn(LINK_CLASS, "disabled:no-underline disabled:opacity-60")}
            onClick={onReset}
            disabled={disabled}
          >
            {t("settings.overrideStatus.reset")}
          </button>
        </>
      ) : null}
      {open && named.length > 0 && projectHref ? (
        <span id={listId} role="list" className="mt-1 block space-y-0.5 pl-3" data-testid="override-status-projects">
          {named.map((project) => (
            <span key={project.id} role="listitem" className="block">
              <Link to={projectHref(project.id)} className={LINK_CLASS}>
                {project.name}
              </Link>
            </span>
          ))}
          {more > 0 ? (
            <span role="listitem" className="block">
              {t("settings.overrideStatus.andMore", { count: more })}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
