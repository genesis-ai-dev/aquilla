import { Fragment } from "react"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { HIDDEN_ANCESTORS, SCOPE_SEPARATOR, formatScopePath, scopePathKey } from "@/lib/access/scope-path"
import type { ScopePath, ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

import { PLACE_ICON } from "./place-icons"

/**
 * A scope path as `Org › Team › Project › Lane`, each crumb carrying its
 * place icon. The rendered text is exactly `formatScopePath(path)` — same
 * bytes as the CSV column, the grant chip and the dialog header — so a grant
 * shown in two places can never read differently. Earlier crumbs link to that
 * ancestor when `hrefFor` returns a URL; the last crumb is the place itself.
 */
export function PlaceBreadcrumb({
  path,
  hrefFor,
  className,
}: {
  path: ScopePath
  hrefFor?: (scope: ScopeRef) => string | undefined
  className?: string
}) {
  const t = useT()
  // §3.9 rule 4: ancestors the server marked hidden collapse into one "…" crumb.
  const visible = path.filter((s) => !s.hidden)
  const hidden = path.length - visible.length
  return (
    <Breadcrumb aria-label={formatScopePath(path)} className={className} data-testid="place-breadcrumb">
      <BreadcrumbList className="gap-0 sm:gap-0">
        {hidden > 0 && (
          <BreadcrumbItem className="text-muted-foreground/60" data-testid="place-hidden-ancestors">
            {HIDDEN_ANCESTORS}
          </BreadcrumbItem>
        )}
        {visible.map((scope, i) => {
          const last = i === visible.length - 1
          const href = last ? undefined : hrefFor?.(scope)
          const Icon = PLACE_ICON[scope.type]
          const icon = (
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden data-place-icon={scope.type} />
          )
          return (
            <Fragment key={scopePathKey(visible.slice(0, i + 1))}>
              {(i > 0 || hidden > 0) && (
                <BreadcrumbSeparator className="whitespace-pre">{SCOPE_SEPARATOR}</BreadcrumbSeparator>
              )}
              <BreadcrumbItem title={t(`org.access.scope.${scope.type}`)}>
                {icon}
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
