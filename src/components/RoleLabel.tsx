import { cn } from "@/lib/utils"
import { roleNameKey, unknownRoleLabel } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * Resolve a role's display label via the active locale. Shared by
 * `<RoleLabel>` and any call site that needs the plain string (e.g. building
 * `<Select>` items outside JSX) — see `resolveRoleName` in
 * `src/lib/frontier/roles.ts` for the non-hook equivalent used by pure lib
 * code that already has a `t()` in hand.
 */
export function useRoleDisplayName(nameOrLevel: string | number, plural = false): string {
  const t = useT()
  const key = roleNameKey(nameOrLevel)
  if (!key) return typeof nameOrLevel === "number" ? unknownRoleLabel(nameOrLevel) : nameOrLevel
  return t(key, { count: plural ? 2 : 1 })
}

interface RoleLabelProps {
  /** Canonical role name (e.g. `project_lead`, `owner`) or numeric level. */
  name: string | number
  /** Render the plural noun ("Viewers") instead of the singular label. */
  plural?: boolean
  className?: string
  as?: "span" | "strong"
}

/** Consistent, localized role label — use anywhere a role name is shown. */
export function RoleLabel({ name, plural, className, as: Tag = "span" }: RoleLabelProps) {
  const label = useRoleDisplayName(name, plural)
  return <Tag className={cn(className)}>{label}</Tag>
}

interface RoleLevelLabelProps {
  level: number
  plural?: boolean
  className?: string
  as?: "span" | "strong"
}

/** Role label derived from a numeric level — identical to `<RoleLabel>`, kept
 *  as a distinct name at call sites that only have a level in hand. */
export function RoleLevelLabel({ level, plural, className, as }: RoleLevelLabelProps) {
  return <RoleLabel name={level} plural={plural} className={className} as={as} />
}
