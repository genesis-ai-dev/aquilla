import type { BrandLogoProps } from "../../types"
import { cn } from "@/lib/utils"
// mark-icon.svg is a filter-free variant: linearGradient bg + white letterform.
// The original mark-purple-dark.svg used heavy feGaussianBlur glow chains that
// browsers rasterize at the displayed pixel size — fine at hero sizes, mushy at
// dock sizes (32–48px). Stripping the filters keeps the brand gradient while
// letting `<img>` paint vector paths crisply at any size.
import markHref from "./mark-icon.svg?url"

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
