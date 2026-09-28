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
import { cn } from "@/lib/utils"

/**
 * AQU-1352 §3.9: a scope rendered as its breadcrumb. The visible text equals
 * `formatScopePath()` so it matches every chip/badge/dialog byte for byte.
 * Earlier crumbs link to that ancestor when `hrefFor` returns a URL; the last
 * crumb is the scope being granted at.
 */
export function ScopeBreadcrumb({
  path,
  hrefFor,
  className,
}: {
  path: ScopePath
  hrefFor?: (scope: ScopeRef) => string | undefined
  className?: string
}) {
  // Rule 4: server-hidden ancestors render as one faded "…" crumb.
  const visible = path.filter((s) => !s.hidden)
  const hidden = path.length - visible.length
  return (
    <Breadcrumb aria-label={formatScopePath(path)} className={className}>
      <BreadcrumbList className="gap-0 sm:gap-0">
        {hidden > 0 && (
          <BreadcrumbItem className="text-muted-foreground/60" data-testid="scope-hidden-ancestors">
            {HIDDEN_ANCESTORS}
          </BreadcrumbItem>
        )}
        {visible.map((scope, i) => {
          const last = i === visible.length - 1
          const href = last ? undefined : hrefFor?.(scope)
          return (
            <Fragment key={scopePathKey(visible.slice(0, i + 1))}>
              {(i > 0 || hidden > 0) && <BreadcrumbSeparator className="whitespace-pre">{SCOPE_SEPARATOR}</BreadcrumbSeparator>}
              <BreadcrumbItem>
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
