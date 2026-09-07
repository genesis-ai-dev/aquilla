import type { BrandLogoProps } from "../../types"
import { cn } from "@/lib/utils"

// Self-contained example mark (no external asset). Encoded as a data URI so the
// example brand has no binary dependency. Replace with your own logo.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="rgb(124,58,237)"/><path d="M20 44 32 18 44 44 M25 36 H39" stroke="white" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const markHref = `data:image/svg+xml,${encodeURIComponent(svg)}`

export function Mark({ className, ...props }: BrandLogoProps) {
  return (
    <img
      src={markHref}
      alt="Acme App"
      draggable={false}
      className={cn("block rounded-[22%] select-none", className)}
      {...props}
    />
  )
}
