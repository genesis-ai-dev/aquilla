import type { ReactNode } from "react"
import { InitialsAvatar, type InitialsAvatarSize } from "@/components/InitialsAvatar"
import { cn } from "@/lib/utils"

type OrgWithAvatarProps = {
  /** Organization display name (also drives avatar color/initials). */
  name: string
  size?: InitialsAvatarSize
  className?: string
  nameClassName?: string
  truncate?: boolean
  children?: ReactNode
}

/**
 * Org identity chip matching OrgSwitcher: colored InitialsAvatar + name.
 * Prefer this anywhere an organization is the primary label in a list/table.
 */
export function OrgWithAvatar({
  name,
  size = "sm",
  className,
  nameClassName,
  truncate = true,
  children,
}: OrgWithAvatarProps) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <span aria-hidden className="shrink-0">
        <InitialsAvatar name={name} size={size} />
      </span>
      <span
        data-slot="org-name"
        className={cn(
          "font-medium text-foreground",
          truncate && "truncate",
          nameClassName,
        )}
      >
        {name}
      </span>
      {children}
    </span>
  )
}
