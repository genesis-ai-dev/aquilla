import type { ReactNode } from "react"
import { InitialsAvatar, type InitialsAvatarSize } from "@/components/InitialsAvatar"
import { cn } from "@/lib/utils"

type UsernameWithAvatarProps = {
  /** Stable identity used for avatar color/initials. */
  username: string
  /** Visible label; defaults to `username`. */
  label?: string
  size?: InitialsAvatarSize
  className?: string
  nameClassName?: string
  /** When false, the name does not truncate. Default true. */
  truncate?: boolean
  /** Preserve avatar colors inside menu/select items. */
  menuSafe?: boolean
  /** Optional test id on the name span. */
  nameTestId?: string
  /** Optional trailing content (badges, source labels, etc.). */
  children?: ReactNode
}

/**
 * Standard people identity chip: colored InitialsAvatar + username.
 * Prefer this anywhere a username is the primary label in a list/table row.
 */
export function UsernameWithAvatar({
  username,
  label,
  size = "sm",
  className,
  nameClassName,
  truncate = true,
  menuSafe = false,
  nameTestId,
  children,
}: UsernameWithAvatarProps) {
  const text = label ?? username
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      {/* Decorative when the username text is visible beside it. */}
      <span aria-hidden className="shrink-0">
        <InitialsAvatar
          name={username}
          size={size}
          singleInitial
          menuSafe={menuSafe}
        />
      </span>
      <span
        data-slot="username"
        data-testid={nameTestId}
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
