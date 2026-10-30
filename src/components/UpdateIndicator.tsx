import { useEffect, useRef } from "react"
import { useLocation } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isEditorPath, useUpdateCheck } from "@/hooks/useUpdateCheck"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

/**
 * The small "a newer build is deployed" mark next to the version string
 * (2026-10-30 hourly-release decision: no floating button). Click reloads;
 * ignoring it is fine. Renders nothing until the poller sees a new build.
 */
export function UpdateIndicator({ className }: { className?: string }) {
  const t = useT()
  const available = useUpdateCheck()
  if (!available) return null

  const label = t("workspace.updateBanner.updateAvailable")
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-slot="update-indicator"
            onClick={() => window.location.reload()}
            aria-label={label}
            className={cn("h-auto min-w-0 gap-1 rounded-md px-1 py-1 font-mono text-[10px] leading-none text-violet-600 hover:text-violet-700 dark:text-violet-300", className)}
          >
            <span className="relative flex h-1.5 w-1.5" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-violet-500" />
            </span>
            {t("workspace.updateIndicator.short")}
          </Button>
        }
      />
      <TooltipContent>{t("workspace.updateIndicator.tooltip")}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Picks a newer build up on the next page change that is not into the
 * editor. Mounted once in App; renders nothing. The reload never fires on
 * its own while the pathname is an editor route, and never on the first
 * render (a page the user just opened is not a page they just left).
 */
export function UpdateOnNavigate() {
  const available = useUpdateCheck()
  const { pathname } = useLocation()
  const previous = useRef(pathname)

  useEffect(() => {
    const moved = previous.current !== pathname
    previous.current = pathname
    if (moved && available && !isEditorPath(pathname)) window.location.reload()
  }, [pathname, available])

  return null
}
