import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation } from "react-router-dom"
import { Check } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import { formatBuildInfo, formatBuildLabel, type BuildIdentity } from "@/lib/build-label"
import {
  resolveBackendEnvironment,
  type DeploymentEnvironment,
} from "@/lib/deployment-environment"
import type { MessageKey } from "@/lib/i18n/messages/en"

declare const __APP_VERSION__: string
declare const __APP_BRANCH__: string
declare const __APP_SHA__: string
declare const __APP_BUILT_AT__: string

const VERSION = __APP_VERSION__
const BRANCH = __APP_BRANCH__
const SHA = __APP_SHA__
const BUILT_AT = __APP_BUILT_AT__

const IDENTITY: BuildIdentity = { version: VERSION, branch: BRANCH, sha: SHA, builtAt: BUILT_AT }
const label = formatBuildLabel(IDENTITY)
const title = formatBuildInfo(IDENTITY)

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

  // Project workspace (LeftDock or AppShell footer VersionTag) — editor dock routes
  // and AppShell pages like settings. Bare debug dumps stay badge-only.
  if (root === "project" && segs.length >= 2) {
    if (segs.includes("debug")) return false
    return true
  }

  return false
}

// AQU-1022: which backend (and so which database) this build talks to. Resolved
// once from the build-time API hosts — it can't change while the tab is open.
const BACKEND = resolveBackendEnvironment()

const ENVIRONMENT_LABEL_KEYS: Record<
  Exclude<DeploymentEnvironment, "production">,
  MessageKey
> = {
  development: "nav.environment.development",
  preview: "nav.environment.preview",
  local: "nav.environment.local",
  unknown: "nav.environment.unknown",
}

/**
 * Non-production data warning shown beside the build string. Deliberately the
 * one coloured thing in an otherwise grey footer so a screenshot passed around
 * out of context still says "this is not prod" — and absent entirely on
 * production, where it would be noise.
 */
function EnvironmentTag({ className }: { className?: string }) {
  const t = useT()
  const kind = BACKEND.kind
  if (kind === "production") return null

  const label = t(ENVIRONMENT_LABEL_KEYS[kind])
  const description = t("nav.environment.tooltip", { host: BACKEND.host })

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            className={cn(
              "shrink-0 border-amber-500/40 bg-amber-500/15 font-mono text-[10px] tracking-wide text-amber-800 uppercase dark:text-amber-300",
              className,
            )}
            aria-label={description}
          >
            {label}
          </Badge>
        }
      />
      <TooltipContent className="max-w-xs">{description}</TooltipContent>
    </Tooltip>
  )
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
  const t = useT()
  const { copied, copy } = useCopyBuildInfo()

  return (
    <div className="mt-auto flex w-full min-w-0 shrink-0 items-center gap-1">
      <EnvironmentTag />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={copy}
              className={cn(
                "h-auto min-w-0 flex-1 justify-start rounded-md px-3 py-1.5 font-mono text-[10px] leading-none",
                copied
                  ? "text-emerald-600 hover:text-emerald-600"
                  : "text-muted-foreground/40 hover:text-muted-foreground/70",
              )}
              aria-label={copied ? t("nav.version.copiedAriaLabel") : t("nav.version.copyAriaLabel")}
            >
              {copied ? (
                <>
                  <Check className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{t("nav.version.copiedLabel")}</span>
                </>
              ) : (
                <span className="truncate">{label}</span>
              )}
            </Button>
          }
        />
        <TooltipContent side="right" className="max-w-xs whitespace-pre-wrap font-mono">
          {copied ? t("nav.version.copiedTooltip") : t("nav.version.copyTooltip", { buildInfo: title })}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * Floating badge for screens without a left rail (dashboard, onboarding, join,
 * settings, centred project pages). Click to copy build info.
 */
export function VersionBadge() {
  const t = useT()
  const { pathname } = useLocation()
  const { copied, copy } = useCopyBuildInfo()
  if (hasChromeVersionTag(pathname)) return null

  return (
    <div className="fixed bottom-3 start-3 z-30 flex max-w-[90vw] items-center gap-1">
      <EnvironmentTag className="bg-card border-amber-500/50" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={copy}
              className={cn(
                "bg-card h-auto min-w-0 rounded-md px-3 py-1.5 font-mono text-[11px] leading-none",
                copied
                  ? "text-emerald-600 hover:text-emerald-600"
                  : "text-muted-foreground/70 hover:text-muted-foreground",
              )}
              aria-label={copied ? t("nav.version.copiedAriaLabel") : t("nav.version.copyAriaLabel")}
            >
              {copied ? (
                <>
                  <Check className="size-3 shrink-0" aria-hidden />
                  <span>{t("nav.version.copiedLabel")}</span>
                </>
              ) : (
                <span className="max-w-[min(70vw,24rem)] truncate">{label}</span>
              )}
            </Button>
          }
        />
        <TooltipContent className="max-w-xs whitespace-pre-wrap font-mono">
          {copied ? t("nav.version.copiedTooltip") : t("nav.version.copyTooltip", { buildInfo: title })}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
