import { Badge } from "@/components/ui/badge"
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
  /**
   * Skip the members-table badge chrome. Use inside role pickers (name +
   * blurb) and chips that already wrap the label.
   */
  plain?: boolean
}

/** Assigned-role chip matching `/project/:id/settings/members`. */
export function RoleLabel({
  name,
  plural,
  className,
  as: Tag = "span",
  plain = false,
}: RoleLabelProps) {
  const label = useRoleDisplayName(name, plural)
  if (plain) {
    return <Tag className={cn("capitalize", className)}>{label}</Tag>
  }
  return (
    <Badge
      variant="secondary"
      className={cn("font-normal capitalize bg-muted text-muted-foreground", className)}
    >
      {label}
    </Badge>
  )
}

interface RoleLevelLabelProps {
  level: number
  plural?: boolean
  className?: string
  as?: "span" | "strong"
  plain?: boolean
}

/** Role label derived from a numeric level — identical to `<RoleLabel>`, kept
 *  as a distinct name at call sites that only have a level in hand. */
export function RoleLevelLabel({ level, plural, className, as, plain }: RoleLevelLabelProps) {
  return <RoleLabel name={level} plural={plural} className={className} as={as} plain={plain} />
}
