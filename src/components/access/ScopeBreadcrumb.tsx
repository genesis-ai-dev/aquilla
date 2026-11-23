import { Fragment } from "react"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { HIDDEN_ANCESTORS, SCOPE_SEPARATOR, formatScopePath, scopeCrumbs, scopePathKey, viaTeamName } from "@/lib/access/scope-path"
import type { ScopePath, ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

import { PLACE_ICON } from "./place-icons"

/**
 * AQU-2361: the one scope breadcrumb. Replaces ScopeBreadcrumb and
 * PlaceBreadcrumb. The visible text equals `formatScopePath()` so a page
 * title, an add-people header and a grant chip cannot disagree.
 * `icons` keeps the place icons the access tree already draws; page titles
 * leave it off.
 */
export function ScopeBreadcrumb({
  path,
  hrefFor,
  className,
  icons = false,
}: {
  path: ScopePath
  hrefFor?: (scope: ScopeRef) => string | undefined
  className?: string
  /** Draw the place icon on each crumb. Access tree rows pass true. */
  icons?: boolean
}) {
  const t = useT()
  const crumbs = scopeCrumbs(path)
  const visible = crumbs.filter((s) => !s.hidden)
  const hidden = crumbs.length - visible.length
  return (
    <Breadcrumb aria-label={formatScopePath(path)} className={className} data-testid="scope-breadcrumb">
      <BreadcrumbList className="gap-0 sm:gap-0">
        {hidden > 0 && (
          <BreadcrumbItem className="text-muted-foreground/60" data-testid="scope-hidden-ancestors">
            {HIDDEN_ANCESTORS}
          </BreadcrumbItem>
        )}
        {visible.map((scope, i) => {
          const last = i === visible.length - 1
          const href = last ? undefined : hrefFor?.(scope)
          const Icon = PLACE_ICON[scope.type]
          return (
            <Fragment key={scopePathKey(visible.slice(0, i + 1))}>
              {(i > 0 || hidden > 0) && (
                <BreadcrumbSeparator className="whitespace-pre">{SCOPE_SEPARATOR}</BreadcrumbSeparator>
              )}
              <BreadcrumbItem title={icons ? t(`org.access.scope.${scope.type}`) : undefined}>
                {icons && (
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden data-place-icon={scope.type} />
                )}
                {last ? (
                  <BreadcrumbPage>{scope.name}</BreadcrumbPage>
                ) : href ? (
                  <BreadcrumbLink href={href}>{scope.name}</BreadcrumbLink>
                ) : (
                  <span className={cn("text-muted-foreground")}>{scope.name}</span>
                )}
              </BreadcrumbItem>
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

/**
 * The grant chip: the same scope string as the page title, plus "via team …"
 * when the grant came through a team. `viaTeam` null hides the chip; omit it
 * to read the team off the path.
 */
export function ScopeGrantChip({
  path,
  viaTeam,
  className,
}: {
  path: ScopePath
  viaTeam?: string | null
  className?: string
}) {
  const t = useT()
  const scope = formatScopePath(path)
  const team = viaTeam === undefined ? viaTeamName(path) : viaTeam
  const via = team == null
    ? null
    : team
      ? `${t("org.membersPage.sourceViaTeam")} ${team}`
      : t("org.membersPage.sourceViaTeam")
  return (
    <span data-testid="scope-grant-chip" className={className}>
      <span data-testid="scope-grant-scope">{scope}</span>
      {via ? <span data-testid="scope-via-team">{` · ${via}`}</span> : null}
    </span>
  )
}
