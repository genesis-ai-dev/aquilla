/**
 * AQU-1937: the one host component around EVERY place an extension draws UI
 * (side panel, page, editor, cell tab, Review & try preview, import progress).
 *
 * It is drawn by the HOST, outside the sandboxed iframe, in the reserved
 * --extension-accent color that is never forwarded into frames — so an
 * extension cannot draw, hide or restyle it, and users can always tell
 * app-proper UI from extension content. A thin border plus an edge tab with
 * the extension icon, its name and "Smart Extension", linking to its page
 * (permissions, versions). The default editor uses the QUIET variant: a
 * hairline and the compact label.
 *
 * Every visible tool iframe goes through here (extension-identity.test.ts
 * fails otherwise). One of the two files allowed to use the reserved token
 * (the other is ExtensionMarker.tsx).
 */

import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Blocks } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

export interface ExtensionFrameProps {
  /** The extension's name, as installed (or as built, in a preview). */
  name: string
  /** Links the tab to the extension's page (permissions, versions); absent in previews. */
  href?: string
  variant?: "full" | "quiet"
  className?: string
  children: ReactNode
}

export function ExtensionFrame({ name, href, variant = "full", className, children }: ExtensionFrameProps) {
  const t = useT()
  const label = (
    <>
      <Blocks className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
      <span aria-hidden>·</span>
      <span className="shrink-0">{t("extensions.identity.label")}</span>
    </>
  )
  const tabClass =
    variant === "full"
      ? "inline-flex max-w-full items-center gap-1 rounded-t-md bg-[var(--extension-accent)] px-2 py-0.5 text-[11px] font-medium leading-4 text-[var(--extension-accent-foreground)] hover:opacity-90"
      : "inline-flex max-w-full items-center gap-1 rounded-full bg-background px-1.5 text-[10px] font-medium leading-4 text-[var(--extension-accent)] hover:underline"
  const tab = href ? (
    <Link to={href} className={tabClass} data-testid="extension-frame-tab" title={t("extensions.identity.open", { name })}>
      {label}
    </Link>
  ) : (
    <span className={tabClass} data-testid="extension-frame-tab">
      {label}
    </span>
  )
  return (
    <section
      className={cn("flex min-h-0 flex-col", className)}
      data-testid="extension-frame"
      data-extension-frame={variant}
      aria-label={t("extensions.identity.region", { name })}
    >
      {variant === "full" ? (
        <div className="flex shrink-0 items-end px-2">{tab}</div>
      ) : (
        // Quiet: a hairline with the compact label sitting ON it — no extra height.
        <div className="relative h-0 shrink-0 border-t border-[var(--extension-accent)]">
          <div className="absolute start-2 top-0 z-10 -translate-y-1/2">{tab}</div>
        </div>
      )}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden",
          variant === "full" ? "rounded-md border-2 border-[var(--extension-accent)]" : "",
        )}
      >
        {children}
      </div>
    </section>
  )
}
