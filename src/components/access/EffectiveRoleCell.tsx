import { formatScopePath } from "@/lib/access/scope-path"
import type { GrantOrigin } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"

import { roleLabel } from "./labels"

/**
 * AQU-1352 §3.7 rule 3: when the direct grant and the effective role differ,
 * show both — "Contributor (direct) → Project Lead (via team BSB)" — never
 * one role alone.
 */
export function EffectiveRoleCell({
  directRoleLevel,
  effectiveRoleLevel,
  effectiveOrigin,
  className,
}: {
  /** The direct grant at this scope, if any. */
  directRoleLevel?: number | null
  effectiveRoleLevel: number | null
  /** Origin of the grant that produces the effective role. */
  effectiveOrigin: GrantOrigin
  className?: string
}) {
  const t = useT()
  const effective = roleLabel(t, effectiveRoleLevel)
  if (directRoleLevel == null || directRoleLevel === effectiveRoleLevel) {
    return <span className={className}>{effective}</span>
  }
  const direct = t("org.access.effective.direct", { role: roleLabel(t, directRoleLevel) })
  let via: string
  switch (effectiveOrigin.kind) {
    case "creator":
      via = t("org.access.effective.creator", { role: effective })
      break
    case "platform":
      via = t("org.access.effective.platform", { role: effective })
      break
    case "inherited":
      via = effectiveOrigin.from?.length
        ? t("org.access.effective.via", { role: effective, path: formatScopePath(effectiveOrigin.from) })
        : effective
      break
    case "direct":
      via = effective
  }
  return (
    <span className={className}>
      {direct} {"→"} {via}
    </span>
  )
}
