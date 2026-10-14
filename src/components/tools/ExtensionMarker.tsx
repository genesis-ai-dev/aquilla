/**
 * AQU-1937: the Smart Extensions marker for platform screens ABOUT extensions
 * (the builder, extension pages, the permission prompt, "From extensions"
 * entries, palette/menu entries an extension contributes, "Edit with"
 * extension options). Always the reserved color PLUS the icon and a label —
 * never color alone. One of the two files allowed to use the reserved
 * --extension-accent token (the other is ExtensionFrame.tsx).
 */

import type { ReactNode } from "react"
import { Blocks } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

/** A small chip: the extension icon + "Smart Extension" (or a given label). */
export function ExtensionMarker({ label, className, iconOnly = false }: { label?: string; className?: string; iconOnly?: boolean }) {
  const t = useT()
  const text = label ?? t("extensions.identity.label")
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--extension-accent-subtle)] px-1.5 py-px text-[11px] font-medium leading-4 text-[var(--extension-accent)]",
        className,
      )}
      data-extension-marker=""
      {...(iconOnly ? { "aria-label": text, title: text } : {})}
    >
      <Blocks className="size-3" aria-hidden />
      {!iconOnly && text}
    </span>
  )
}

/** A row/section with the accent stripe on its start edge (paired with a marker inside). */
export function ExtensionStripe({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("border-s-2 border-[var(--extension-accent)] ps-2", className)} data-extension-stripe="">
      {children}
    </div>
  )
}
