import type { ReactNode } from "react"
import { UserChip } from "@/components/UserChip"
import type { InitialsAvatarShape, InitialsAvatarSize } from "@/components/InitialsAvatar"

type UsernameWithAvatarProps = {
  /** Stable identity used for avatar color/initials. */
  username: string
  /** Account id, when the caller has one. Shown in the tooltip, not the label. */
  userId?: string | number | null
  /**
   * Visible label. Defaults to the username. Use this only for the username
   * plus a short qualifier ("anna (you)"), never a real name or a raw id.
   */
  label?: string
  size?: InitialsAvatarSize
  shape?: InitialsAvatarShape
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
 * The user chip, under the name older call sites already import.
 * New call sites should use `UserChip` directly.
 */
export function UsernameWithAvatar({
  username,
  userId,
  label,
  size = "sm",
  shape,
  className,
  nameClassName,
  truncate = true,
  menuSafe = false,
  nameTestId,
  children,
}: UsernameWithAvatarProps) {
  return (
    <UserChip
      userId={userId}
      username={username}
      visibleLabel={label}
      size={size}
      shape={shape}
      className={className}
      nameClassName={nameClassName}
      truncate={truncate}
      menuSafe={menuSafe}
      nameTestId={nameTestId}
    >
      {children}
    </UserChip>
  )
}
