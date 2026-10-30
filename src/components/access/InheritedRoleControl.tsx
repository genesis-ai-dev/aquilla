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
 * same sentence as its note. AQU-2260 (Sam, Oct 29): that sentence opens on
 * CLICK, in a note anchored to the control, never on hover. AppTooltip does
 * that for a natively-disabled child, so the child goes to it directly; a
 * hand-made wrapper span in between would hand it a non-disabled trigger and
 * bring the hover back.
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
      <span data-testid="inherited-role-control" className="inline-flex">
        <AppTooltip content={hint}>
          {cloneElement(children, { disabled: true, "aria-describedby": descId })}
        </AppTooltip>
      </span>
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
