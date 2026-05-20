// Shared app chrome — a thin top bar so projects/billing/org all look
// like the same app. Every consumer wires its own title + actions; the
// theme toggle is bundled in by default (opt out with `includeThemeToggle={false}`
// if a page wants to suppress it).

import type { ReactNode } from "react"
import { ThemeToggle } from "./theme-mode"
import { cn } from "./cn"

interface AppHeaderProps {
  /** Left-side label. Plain string most of the time; ReactNode for branded logo + label combos. */
  title: ReactNode
  /** Right-side actions (links, buttons). Theme toggle is appended automatically. */
  actions?: ReactNode
  /** Optional href for the title — wraps in an `<a>`. Use for "back to app root" links. */
  titleHref?: string
  /** Hide the theme toggle (e.g. for a sub-page that already shows one). */
  includeThemeToggle?: boolean
  className?: string
}

export function AppHeader({
  title,
  actions,
  titleHref,
  includeThemeToggle = true,
  className,
}: AppHeaderProps) {
  const titleNode = (
    <span className="text-base font-semibold tracking-tight">{title}</span>
  )
  return (
    <header
      className={cn(
        "bg-background shadow-[0_5px_14px_-8px_var(--neu-dark)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          {titleHref ? (
            <a href={titleHref} className="hover:opacity-80">
              {titleNode}
            </a>
          ) : (
            titleNode
          )}
        </div>
        <div className="flex items-center gap-1">
          {actions}
          {includeThemeToggle ? <ThemeToggle /> : null}
        </div>
      </div>
    </header>
  )
}
