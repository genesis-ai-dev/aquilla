// Fixed-position theme toggle for full-screen pages that don't have an
// AppHeader (login, signup, reset, billing's coming-soon shell, etc.).
//
// Lives in the top-right corner with a `z-50` so it sits above any
// page-level chrome. Apps that already render an `<AppHeader />` don't
// need this — the toggle is part of the header's action row.

import { ThemeToggle } from "./theme-mode"
import { cn } from "./cn"

interface FloatingThemeToggleProps {
  className?: string
}

export function FloatingThemeToggle({ className }: FloatingThemeToggleProps) {
  return (
    <div
      className={cn(
        "fixed right-3 top-3 z-50 rounded-md border bg-background/80 shadow-sm backdrop-blur",
        className,
      )}
    >
      <ThemeToggle />
    </div>
  )
}
