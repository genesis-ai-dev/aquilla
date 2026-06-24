import { useState } from "react"
import { HelpCircle, MessageCircle, Mail } from "lucide-react"

// Configured at build time. The Discord link is only shown when an invite URL
// is set, so we never ship a dead "community" link. Support email has a sane
// default so there is always a way to reach a human.
const DISCORD_URL =
  (import.meta.env.VITE_DISCORD_INVITE_URL as string | undefined)?.trim() || ""
const SUPPORT_EMAIL =
  (import.meta.env.VITE_SUPPORT_EMAIL as string | undefined)?.trim() ||
  "support@aquilla.app"

/**
 * Global help + community affordance (the escape hatch the UX audit flagged as
 * missing). Feedback already has a home via ReportProblemButton; this adds the
 * two things that didn't exist anywhere in-app: a community link and a way to
 * contact a human.
 */
export function HelpMenu() {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
        Help &amp; community
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-20 mb-1 w-full rounded-md border bg-popover p-1 shadow-md"
        >
          {DISCORD_URL && (
            <a
              role="menuitem"
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
            >
              <MessageCircle className="h-3.5 w-3.5" aria-hidden /> Join our community
            </a>
          )}
          <a
            role="menuitem"
            href={`mailto:${SUPPORT_EMAIL}`}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
          >
            <Mail className="h-3.5 w-3.5" aria-hidden /> Contact support
          </a>
        </div>
      )}
    </div>
  )
}
