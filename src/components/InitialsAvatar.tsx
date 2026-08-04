import type { CSSProperties, ReactNode } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import { colorFromName, initialsFromName, singleInitialFromName } from "@/lib/avatar-utils"

export type InitialsAvatarSize = "xs" | "sm" | "default" | "lg"
export type InitialsAvatarShape = "circle" | "square"

const sizeClasses: Record<InitialsAvatarSize, string> = {
  xs: "size-5",
  sm: "size-6",
  default: "size-8",
  lg: "size-10",
}

const textClasses: Record<InitialsAvatarSize, string> = {
  xs: "text-[10px] font-semibold",
  sm: "text-[10px] font-semibold",
  default: "text-sm font-semibold",
  lg: "text-sm font-semibold",
}

/** Inline color survives dropdown item `focus:**:text-accent-foreground`. */
function menuSafeStyle(color: string | undefined): CSSProperties | undefined {
  return color ? { color } : undefined
}

type InitialsAvatarProps = {
  name: string
  size?: InitialsAvatarSize
  shape?: InitialsAvatarShape
  color?: string
  className?: string
  fallbackClassName?: string
  menuSafe?: boolean
  /** Preserved text/icon color inside menu items. Defaults to white for colored fallbacks. */
  menuSafeColor?: string
  singleInitial?: boolean
  children?: ReactNode
}

export function InitialsAvatar({
  name,
  size = "default",
  shape = "square",
  color,
  className,
  fallbackClassName,
  menuSafe = false,
  menuSafeColor,
  singleInitial = false,
  children,
}: InitialsAvatarProps) {
  const circle = shape === "circle"
  const label = singleInitial ? singleInitialFromName(name) : initialsFromName(name)
  const bg = color ?? colorFromName(name)
  const hasCustomFallback = Boolean(fallbackClassName)
  const usesColoredFallback = !children && !hasCustomFallback
  const preservedColor = menuSafe
    ? (menuSafeColor ?? (usesColoredFallback ? "#ffffff" : undefined))
    : undefined

  return (
    <Avatar
      className={cn(
        sizeClasses[size],
        // Default matches sidebar (rounded-md on Avatar). Circle is opt-in.
        circle && "rounded-full after:rounded-full",
        className,
      )}
    >
      <AvatarFallback
        className={cn(
          circle && "rounded-full",
          textClasses[size],
          usesColoredFallback && !menuSafe && "text-white",
          fallbackClassName,
        )}
        style={{
          ...(usesColoredFallback ? { backgroundColor: bg } : {}),
          ...menuSafeStyle(preservedColor),
        }}
      >
        {children ?? label}
      </AvatarFallback>
    </Avatar>
  )
}
