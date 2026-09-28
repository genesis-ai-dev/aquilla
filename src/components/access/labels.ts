import type { TFunction } from "@/lib/i18n/I18nProvider"
import { resolveRoleName } from "@/lib/frontier/roles"
import { formatScopePath } from "@/lib/access/scope-path"
import type { GrantOrigin } from "@/lib/access/types"

/** AQU-1352 §3.7 rule 1: the badge text for a grant origin. Never a number. */
export function originLabel(t: TFunction, origin: GrantOrigin): string {
  switch (origin.kind) {
    case "direct":
      return t("org.accessModelLegend.direct.label")
    case "creator":
      return t("org.accessModelLegend.creator.label")
    case "platform":
      return t("org.access.origin.platform")
    case "inherited":
      return origin.from?.length
        ? t("org.access.origin.inheritedFrom", { path: formatScopePath(origin.from) })
        : t("org.access.origin.inherited")
  }
}

/** Role label or "No access"; levels are never rendered as numbers. */
export function roleLabel(t: TFunction, level: number | null): string {
  return level == null ? t("org.access.noAccess") : resolveRoleName(t, level)
}
