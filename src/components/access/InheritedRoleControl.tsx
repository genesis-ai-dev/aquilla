import { cloneElement, useId } from "react"
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
 *
 * A11y: the disabled control is described by visually-hidden text holding the
 * same sentence as the tooltip. When the link is present it is the keyboard
 * route, so the hover wrapper is not an extra tab stop.
 */
export function InheritedRoleControl({
  origin,
  hrefFor,
  children,
}: {
  origin: GrantOrigin
  /** URL of a scope's access page; the link targets the grant's own scope. */
  hrefFor?: (scope: ScopeRef) => string | undefined
  children: ReactElement<{ disabled?: boolean; "aria-describedby"?: string }>
}) {
  const t = useT()
  const descId = useId()
  if (origin.kind !== "inherited" || !origin.from?.length) return children
  const path = formatScopePath(origin.from)
  const target = origin.from[origin.from.length - 1]
  // Never link into a scope the viewer cannot see (spec §3.9 rule 4).
  const href = target.hidden ? undefined : hrefFor?.(target)
  const hint = t("org.access.inherited.tooltip", { path })
  return (
    <span className="inline-flex items-center gap-2" data-inherited="true">
      <AppTooltip content={hint} delay={0}>
        {/* Disabled controls swallow pointer events; the span is the hover target. */}
        {/* Without a link it stays focusable (for the tooltip) and is named by the hint. */}
        <span
          data-testid="inherited-role-control"
          {...(href ? {} : { tabIndex: 0, role: "group", "aria-label": hint })}
        >
          {cloneElement(children, { disabled: true, "aria-describedby": descId })}
        </span>
      </AppTooltip>
      <span id={descId} className="sr-only">
        {hint}
      </span>
      {href && (
        <a href={href} className="text-xs text-primary underline-offset-4 hover:underline">
          {t("org.access.inherited.link", { path })}
        </a>
      )}
    </span>
  )
}
