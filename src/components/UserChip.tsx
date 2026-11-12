import type { ReactNode } from "react"
import { InitialsAvatar, type InitialsAvatarShape, type InitialsAvatarSize } from "@/components/InitialsAvatar"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { appearanceForUserId, usernameForChip, type UserChipShape } from "@/lib/user-chip"
import { cn } from "@/lib/utils"

const markSize: Record<InitialsAvatarSize, string> = {
  xs: "size-5",
  sm: "size-6",
  default: "size-8",
  lg: "size-10",
}

function ShapeMark({ shape, color, size }: { shape: UserChipShape; color: string; size: InitialsAvatarSize }) {
  return (
    <svg
      viewBox="0 0 16 16"
      data-slot="user-chip-shape"
      data-shape={shape}
      aria-hidden
      className={markSize[size]}
      style={{ color }}
    >
      {shape === "circle" && <circle cx="8" cy="8" r="6" fill="currentColor" />}
      {shape === "square" && <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor" />}
      {shape === "diamond" && <polygon points="8,1.5 14.5,8 8,14.5 1.5,8" fill="currentColor" />}
      {shape === "triangle" && <polygon points="8,1.5 14.5,14 1.5,14" fill="currentColor" />}
      {shape === "hexagon" && (
        <polygon points="8,1.5 13.5,4.75 13.5,11.25 8,14.5 2.5,11.25 2.5,4.75" fill="currentColor" />
      )}
    </svg>
  )
}

export type UserChipProps = {
  /** Account id. Shown in the tooltip, and the seed for an anonymous shape and color. */
  userId?: string | number | null
  /**
   * Account username. Blank, "local", and "anonymous" count as missing.
   * Pass the username only — not users.display_name and not an email.
   */
  username?: string | null
  /**
   * Stable id used only to pick an anonymous shape when there is no user id
   * (a presence connection). Never written into the tooltip.
   */
  distinguishId?: string | number | null
  /**
   * Visible text when it is still the username plus a short qualifier
   * ("anna (you)"). Not a place for a real name or a raw id.
   */
  visibleLabel?: string | null
  size?: InitialsAvatarSize
  /** Initials mark for a person who has a username. Anonymous shapes ignore this. */
  shape?: InitialsAvatarShape
  /** Presence already picked a color; keep the caret and the chip the same. */
  color?: string
  /** Mark only. The name moves into the tooltip beside the user id. */
  avatarOnly?: boolean
  /** Name only, when a mark is already drawn beside this chip. */
  hideMark?: boolean
  className?: string
  nameClassName?: string
  truncate?: boolean
  menuSafe?: boolean
  nameTestId?: string
  /** Extra tooltip line, such as a role. */
  hint?: string
  children?: ReactNode
}

/**
 * The one person chip. Username is the label. The user id is the tooltip.
 * No username: the label is "User", with a shape and color from the user id.
 */
export function UserChip({
  userId,
  username,
  distinguishId,
  visibleLabel,
  size = "sm",
  shape,
  color,
  avatarOnly = false,
  hideMark = false,
  className,
  nameClassName,
  truncate = true,
  menuSafe = false,
  nameTestId,
  hint,
  children,
}: UserChipProps) {
  const t = useT()
  const handle = usernameForChip(username)
  const anonymous = handle == null
  const label = (visibleLabel?.trim() || handle) ?? t("common.userChip.anonymous")
  const idText = userId == null || String(userId).trim() === "" ? null : String(userId)
  const appearance = appearanceForUserId(idText ?? distinguishId)
  const markColor = color ?? (anonymous ? appearance.color : undefined)

  const chip = (
    <span
      data-slot="user-chip"
      data-user-id={idText ?? undefined}
      data-anonymous={anonymous ? "true" : undefined}
      aria-label={avatarOnly ? label : undefined}
      className={cn(
        "inline-flex min-w-0 items-center",
        avatarOnly ? "shrink-0 rounded-md ring-2 ring-background" : "gap-2",
        className,
      )}
    >
      {hideMark ? null : (
        <span aria-hidden className="shrink-0">
          {anonymous ? (
            <ShapeMark shape={appearance.shape} color={markColor ?? appearance.color} size={size} />
          ) : (
            <InitialsAvatar name={handle} size={size} shape={shape} color={markColor} menuSafe={menuSafe} />
          )}
        </span>
      )}
      {avatarOnly ? null : (
        <span
          data-slot="username"
          data-testid={nameTestId}
          className={cn("font-medium text-foreground", truncate && "truncate", nameClassName)}
          style={color ? { color } : undefined}
        >
          {label}
        </span>
      )}
      {children}
    </span>
  )

  const tooltip = idText || (avatarOnly && label) || hint ? (
    <span className="flex flex-col gap-0.5">
      {avatarOnly ? <span>{label}</span> : null}
      {idText ? <span>{t("common.userChip.idTooltip", { id: idText })}</span> : null}
      {hint ? <span>{hint}</span> : null}
    </span>
  ) : null

  if (!tooltip) return chip
  return <AppTooltip content={tooltip}>{chip}</AppTooltip>
}
