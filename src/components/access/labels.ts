import type { TFunction } from "@/lib/i18n/I18nProvider"
import { roleNameKey } from "@/lib/frontier/roles"
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

/**
 * Role label or "No access". Levels are never rendered as numbers: an
 * off-ladder level gets a translated generic label, not resolveRoleName's
 * English "Level N" fallback.
 */
export function roleLabel(t: TFunction, level: number | null): string {
  if (level == null) return t("org.access.noAccess")
  const key = roleNameKey(level)
  return key ? t(key, { count: 1 }) : t("org.access.unknownRole")
}
