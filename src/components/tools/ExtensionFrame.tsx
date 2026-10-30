/**
 * AQU-1937: the one host component around EVERY place an extension draws UI
 * (side panel, page, editor, cell tab, Review & try preview, import progress).
 *
 * It is drawn by the HOST, outside the sandboxed iframe, in the reserved
 * --extension-accent family that is never forwarded into frames — so an
 * extension cannot draw, hide or restyle it, and users can always tell
 * app-proper UI from extension content. A 1px low-opacity hairline with a
 * faint outer glow, plus a soft label tab (tinted background, quiet text, the
 * extension icon, its name and "Smart Extension") linking to its page
 * (permissions, versions). The editor uses the QUIET variant: a hairline only;
 * its marker (linking to the extension's page) sits in the "Edit with" row.
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
      <Blocks className="size-3 shrink-0 text-[var(--extension-accent)]" aria-hidden />
      <span className="truncate text-foreground/80">{name}</span>
      <span aria-hidden className="text-[var(--extension-accent-line)]">·</span>
      <span className="shrink-0 text-[var(--extension-accent)]">{t("extensions.identity.label")}</span>
    </>
  )
  const tabClass = "inline-flex max-w-full items-center gap-1 rounded-t-md border border-b-0 border-[var(--extension-accent-line)] bg-[var(--extension-accent-subtle)] px-2 py-px text-[11px] font-medium leading-4 transition-colors hover:border-[var(--extension-accent)]"
  const tab = href ? (
    <Link to={href} className={tabClass} data-testid="extension-frame-tab">
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
        // Quiet (the editor): just the hairline, no visible tab: nothing can clip
        // or overlap the toolbar above. The host-drawn marker lives in the
        // "Edit with" row (ExtensionEditorSwitcher), which already names the
        // editor; the label stays here for assistive tech.
        <div className="relative h-0 shrink-0 border-t border-[var(--extension-accent-line)]">
          <span className="sr-only" data-testid="extension-frame-tab">
            {name} · {t("extensions.identity.label")}
          </span>
        </div>
      )}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden",
          // A hairline plus a faint glow at the edge: present, never loud.
          variant === "full" ? "rounded-md border border-[var(--extension-accent-line)] shadow-[0_0_0_3px_var(--extension-accent-glow)]" : "",
        )}
      >
        {children}
      </div>
    </section>
  )
}
