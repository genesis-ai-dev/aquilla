import type { BrandLogoProps } from "../../types"
import { cn } from "@/lib/utils"

// Simple text wordmark for the example brand. Replace with your own.
export function Wordmark({ className, ...props }: BrandLogoProps) {
  return (
    <span className={cn("font-semibold tracking-tight select-none", className)} {...props}>
      Acme App
    </span>
  )
}
