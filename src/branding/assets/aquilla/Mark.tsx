import type { BrandLogoProps } from "../../types"
import { cn } from "@/lib/utils"
import markHref from "./mark-purple-dark.svg?url"

// rounded-[22%] matches the macOS/iOS app-icon corner radius (squircle-ish).
// Baked in here so every consumer gets the dock-icon look without remembering.
export function Mark({ className, ...props }: BrandLogoProps) {
  return (
    <img
      src={markHref}
      alt="Aquilla"
      draggable={false}
      className={cn("block rounded-[22%] select-none", className)}
      {...props}
    />
  )
}
