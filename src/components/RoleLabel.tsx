import { cn } from "@/lib/utils"
import { formatRoleDisplay, roleName } from "@/lib/frontier/roles"

interface RoleLabelProps {
  /** Canonical role name (e.g. `project_lead`, `owner`). */
  name: string
  className?: string
  as?: "span" | "strong"
}

/** Consistent capitalized role label — use anywhere a role name is shown. */
export function RoleLabel({ name, className, as: Tag = "span" }: RoleLabelProps) {
  return (
    <Tag className={cn("capitalize", className)}>
      {formatRoleDisplay(name)}
    </Tag>
  )
}

interface RoleLevelLabelProps {
  level: number
  className?: string
  as?: "span" | "strong"
}

/** Capitalized role label derived from a numeric level. */
export function RoleLevelLabel({ level, className, as }: RoleLevelLabelProps) {
  return <RoleLabel name={roleName(level)} className={className} as={as} />
}
