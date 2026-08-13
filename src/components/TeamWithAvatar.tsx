import type { ReactNode } from "react"
import { InitialsAvatar, type InitialsAvatarSize } from "@/components/InitialsAvatar"
import { cn } from "@/lib/utils"

type TeamWithAvatarProps = {
  /** Team display name (also drives avatar color/initials). */
  name: string
  /** Visible label; defaults to `name`. */
  label?: string
  size?: InitialsAvatarSize
  className?: string
  nameClassName?: string
  truncate?: boolean
  children?: ReactNode
}

/**
 * Team identity chip matching OrgWithAvatar: colored InitialsAvatar + name.
 * Prefer this anywhere a team is the primary label in a list/table.
 */
export function TeamWithAvatar({
  name,
  label,
  size = "sm",
  className,
  nameClassName,
  truncate = true,
  children,
}: TeamWithAvatarProps) {
  const text = label ?? name
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <span aria-hidden className="shrink-0">
        <InitialsAvatar name={name} size={size} />
      </span>
      <span
        data-slot="team-name"
        className={cn(
          "font-medium text-foreground",
          truncate && "truncate",
          nameClassName,
        )}
      >
        {text}
      </span>
      {children}
    </span>
  )
}
