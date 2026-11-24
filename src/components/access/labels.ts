import type { TFunction } from "@/lib/i18n/I18nProvider"
import { orgRoleName, roleNameKey } from "@/lib/frontier/roles"
import { formatScopePath, viaTeamName } from "@/lib/access/scope-path"
import type { GrantOrigin, ScopePath } from "@/lib/access/types"

/** AQU-1352 §3.7 rule 1: the badge text for a grant origin. Never a number. */
export function originLabel(t: TFunction, origin: GrantOrigin): string {
  switch (origin.kind) {
    case "direct":
      return t("org.accessModelLegend.direct.label")
    case "creator":
      return t("org.accessModelLegend.creator.label")
    case "platform":
      return t("org.access.origin.platform")
    case "inherited": {
      const from = origin.from ?? []
      const team = viaTeamName(from)
      const scope = formatScopePath(from)
      if (team) {
        const via = `${t("org.membersPage.sourceViaTeam")} ${team}`
        return scope ? `${scope} · ${via}` : via
      }
      return scope
        ? t("org.access.origin.inheritedFrom", { path: scope })
        : t("org.access.origin.inherited")
    }
  }
}

/** An ORGANIZATION role's label: 100 is Member, which opens nothing (AQU-2352). */
export function orgRoleLabel(t: TFunction, level: number | null): string {
  if (level == null) return t("org.access.noAccess")
  const key = roleNameKey(orgRoleName(level))
  return key ? t(key, { count: 1 }) : t("org.access.unknownRole")
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

/** A grant's role label: an org-scope grant is an org role (100 is Member). */
export function grantRoleLabel(t: TFunction, level: number | null, scopePath: ScopePath): string {
  return scopePath.at(-1)?.type === "org" ? orgRoleLabel(t, level) : roleLabel(t, level)
}
