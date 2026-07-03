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

// Routes that render a full-height left rail (via <AppShell/>). There the version
// lives in-flow at the rail's foot (<VersionTag/>), so the floating badge must
// stand down or it duplicates that tag and paints over the rail's bottom controls
// (the account switcher, Settings, the voice library, …).
//   /                            — org overview          (OrgHome)
//   /projects, /projects/:id     — org project list / detail
//   /teams, /teams/:groupId      — org team list / detail
//   /members                     — org members
//   /project/:id                 — workspace
//   /project/:id/file/:fileId    — workspace with a file open
// The other /project/* pages (rules, comments, settings) and /settings are centred
// and leave the corner free, so they keep the floating badge.
function hasLeftRail(pathname: string): boolean {
  const segs = pathname.split("/").filter(Boolean)
  if (segs.length === 0) return true // "/" — org overview
  if (segs[0] === "projects" || segs[0] === "teams" || segs[0] === "members") return true
  if (segs[0] === "project" && segs.length >= 2) {
    return segs.length === 2 || segs[2] === "file"
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
  if (hasLeftRail(pathname)) return null

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
              "bg-card fixed bottom-3 left-3 z-30 h-auto rounded-full px-3 py-1.5 font-mono text-[11px] leading-none",
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
