import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation } from "react-router-dom"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

declare const __APP_VERSION__: string
declare const __APP_BRANCH__: string
declare const __APP_SHA__: string

const VERSION = __APP_VERSION__
const BRANCH = __APP_BRANCH__
const SHA = __APP_SHA__

// Show branch unless we're on the production line — there it's noise.
const isProd = BRANCH === "main" || BRANCH === "production"
const label = isProd ? `v${VERSION} · ${SHA}` : `v${VERSION} · ${BRANCH} · ${SHA}`
const title = `${label}\nbuild: ${BRANCH}@${SHA}`

// Routes where AppShell / LeftDock already render <VersionTag/> in the left-rail
// footer. The floating <VersionBadge/> must stand down there or it stacks on top
// of the in-rail tag and covers the account switcher / report button.
export function hasChromeVersionTag(pathname: string): boolean {
  const segs = pathname.split("/").filter(Boolean)
  if (segs.length === 0) return true // "/" — resumes org overview

  const root = segs[0]

  // Org shell (OrgSidebar + footer VersionTag).
  if (root === "orgs") return true

  // Remaining AppShell pages that keep the floating badge suppressed.
  if (
    root === "projects" ||
    root === "preferences" ||
    root === "admin" ||
    root === "shared"
  ) {
    return true
  }

  // Project workspace (LeftDock footer VersionTag) — every /project/*/editor route except
  // centred shells that don't mount the dock (settings, debug dumps).
  if (root === "project" && segs.length >= 2) {
    if (segs.length >= 3 && segs[2] === "settings") return false
    if (segs.includes("debug")) return false
    return true
  }

  return false
}

function useCopyBuildInfo() {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(title).then(() => {
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    })
  }, [])

  return { copied, copy }
}

/**
 * In-flow version line for the bottom of a left rail. `mt-auto` pins it to the
 * foot of a flex column; it never overlaps content because it occupies layout.
 */
export function VersionTag() {
  const { copied, copy } = useCopyBuildInfo()

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={copy}
            className={cn(
              "mt-auto h-auto min-w-0 w-full shrink-0 justify-start rounded-md px-3 py-1.5 font-mono text-[10px] leading-none",
              copied
                ? "text-emerald-600 hover:text-emerald-600"
                : "text-muted-foreground/40 hover:text-muted-foreground/70",
            )}
            aria-label={copied ? "Build info copied" : "Copy build info"}
          >
            {copied ? (
              <>
                <Check className="size-3 shrink-0" aria-hidden />
                <span className="truncate">Copied</span>
              </>
            ) : (
              <span className="truncate">{label}</span>
            )}
          </Button>
        }
      />
      <TooltipContent side="right" className="max-w-xs whitespace-pre-wrap font-mono">
        {copied ? "Copied to clipboard" : `Click to copy\n${title}`}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Floating badge for screens without a left rail (dashboard, onboarding, join,
 * settings, centred project pages). Click to copy build info.
 */
export function VersionBadge() {
  const { pathname } = useLocation()
  const { copied, copy } = useCopyBuildInfo()
  if (hasChromeVersionTag(pathname)) return null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={copy}
            className={cn(
              "bg-card fixed bottom-3 left-3 z-30 h-auto rounded-md px-3 py-1.5 font-mono text-[11px] leading-none",
              copied
                ? "text-emerald-600 hover:text-emerald-600"
                : "text-muted-foreground/70 hover:text-muted-foreground",
            )}
            aria-label={copied ? "Build info copied" : "Copy build info"}
          >
            {copied ? (
              <>
                <Check className="size-3 shrink-0" aria-hidden />
                <span>Copied</span>
              </>
            ) : (
              <span className="max-w-[min(70vw,24rem)] truncate">{label}</span>
            )}
          </Button>
        }
      />
      <TooltipContent side="top" className="max-w-xs whitespace-pre-wrap font-mono">
        {copied ? "Copied to clipboard" : `Click to copy\n${title}`}
      </TooltipContent>
    </Tooltip>
  )
}
