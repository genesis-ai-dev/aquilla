import { cloneElement } from "react"
import type { ReactElement } from "react"

import { AppTooltip } from "@/components/ui/tooltip"
import { formatScopePath } from "@/lib/access/scope-path"
import type { GrantOrigin, ScopeRef } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * AQU-1352 §3.7 rule 2: inherited rows are read-only in place. The role
 * control is rendered disabled with "Set at <path> — change it there" and a
 * link to the scope where the grant lives. Direct/creator/platform rows pass
 * the control through untouched.
 */
export function InheritedRoleControl({
  origin,
  hrefFor,
  children,
}: {
  origin: GrantOrigin
  /** URL of a scope's access page; the link targets the grant's own scope. */
  hrefFor?: (scope: ScopeRef) => string | undefined
  children: ReactElement<{ disabled?: boolean }>
}) {
  const t = useT()
  if (origin.kind !== "inherited" || !origin.from?.length) return children
  const path = formatScopePath(origin.from)
  const href = hrefFor?.(origin.from[origin.from.length - 1])
  return (
    <span className="inline-flex items-center gap-2" data-inherited="true">
      <AppTooltip content={t("org.access.inherited.tooltip", { path })} delay={0}>
        {/* Disabled controls swallow pointer events; the span is the hover target. */}
        <span tabIndex={0} data-testid="inherited-role-control">
          {cloneElement(children, { disabled: true })}
        </span>
      </AppTooltip>
      {href && (
        <a href={href} className="text-xs text-primary underline-offset-4 hover:underline">
          {t("org.access.inherited.link", { path })}
        </a>
      )}
    </span>
  )
}
