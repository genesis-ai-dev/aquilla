import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Check } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { NoteOnClick } from "@/components/ui/info-note"
import { UpdateIndicator } from "@/components/UpdateIndicator"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  formatBuildInfo,
  formatBuildLabel,
  formatBuildRailLabel,
  type BuildIdentity,
} from "@/lib/build-label"
import {
  resolveBackendEnvironment,
  type DeploymentEnvironment,
} from "@/lib/deployment-environment"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { getDesktopVersions, type DesktopVersions } from "@/lib/offline/bundle-update"

declare const __APP_VERSION__: string
declare const __APP_BRANCH__: string
declare const __APP_SHA__: string
declare const __APP_BUILT_AT__: string

const VERSION = __APP_VERSION__
const BRANCH = __APP_BRANCH__
const SHA = __APP_SHA__
const BUILT_AT = __APP_BUILT_AT__

const BAKED: BuildIdentity = { version: VERSION, branch: BRANCH, sha: SHA, builtAt: BUILT_AT }

/**
 * The build identity to show. On the web it is what the build baked in. Inside
 * the desktop shell the version is the installed shell's own — the number in
 * the About window and on the download — because a hot-updated web bundle only
 * knows the version of the source it was built from, not the shell it runs in.
 */
function useBuildIdentity(): BuildIdentity {
  const [desktop, setDesktop] = useState<DesktopVersions | null>(null)
  useEffect(() => {
    let live = true
    void getDesktopVersions().then((versions) => {
      if (live && versions) setDesktop(versions)
    })
    return () => {
      live = false
    }
  }, [])
  return useMemo(
    () => (desktop ? { ...BAKED, version: desktop.shell, bundle: desktop.bundle ?? undefined } : BAKED),
    [desktop],
  )
}

/**
 * Whether an in-flow version line (the rail <VersionTag/>, or an inline
 * <VersionBadge/> in an auth-page footer) is mounted somewhere on the page. The
 * floating <VersionBadge/> stands down while one is, so it never stacks on top
 * of the rail footer and covers the account switcher, Help or localization.
 *
 * A mount count rather than a route list: the list leaked every time a page
 * adopted AppShell without being added to it (the Paratext bridge pages were
 * the latest), and the fixed badge then sat on top of the rail's own tag.
 */
interface InFlowVersionRegistry {
  mounted: number
  register: () => () => void
}

const InFlowVersionContext = createContext<InFlowVersionRegistry>({
  mounted: 0,
  register: () => () => {},
})

/** Wrap the app once, above both the routes and the floating <VersionBadge/>. */
export function InFlowVersionProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(0)
  const register = useCallback(() => {
    setMounted((n) => n + 1)
    return () => setMounted((n) => n - 1)
  }, [])
  const value = useMemo(() => ({ mounted, register }), [mounted, register])
  return <InFlowVersionContext.Provider value={value}>{children}</InFlowVersionContext.Provider>
}

/** Layout effect, so the floating badge is gone before the first paint. */
function useRegisterInFlowVersion() {
  const { register } = useContext(InFlowVersionContext)
  useLayoutEffect(() => register(), [register])
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

  // AQU-2260 (Sam, Oct 29): what the badge means opens on click, not hover.
  return (
    <NoteOnClick note={description} label={description} align="start" className="shrink-0">
      <Badge
        className={cn(
          "shrink-0 border-amber-500/40 bg-amber-500/15 font-mono text-[10px] tracking-wide text-amber-800 uppercase dark:text-amber-300",
          className,
        )}
      >
        {label}
      </Badge>
    </NoteOnClick>
  )
}

function useCopyBuildInfo(title: string) {
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
  }, [title])

  return { copied, copy }
}

/**
 * In-flow version block for the bottom of a left rail. `mt-auto` pins it to the
 * foot of a flex column; it never overlaps content because it occupies layout.
 *
 * AQU-1523: a column, not a row. The environment badge sits ABOVE the build
 * label rather than beside it, so the label spans the rail's full width — a
 * preview walk at the default 224px measured the label's fitted text at 13px
 * ("v0") while the badge, Help and localization shared its line. Everything
 * that is not the label itself now sits on a different line. Narrower than the
 * default still truncates with an ellipsis, which is the intended degradation.
 */
export function VersionTag() {
  const t = useT()
  const identity = useBuildIdentity()
  /** AQU-1523: the width-bound variant for the left rail; see build-label.ts. */
  const railLabel = formatBuildRailLabel(identity)
  const title = formatBuildInfo(identity)
  const { copied, copy } = useCopyBuildInfo(title)
  useRegisterInFlowVersion()

  return (
    <div
      data-slot="version-tag"
      className="mt-auto flex w-full min-w-0 shrink-0 flex-col items-start gap-0.5"
    >
      <EnvironmentTag />
      <UpdateIndicator />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={copy}
              className={cn(
                // px-1, not px-3: 16px of padding is 2.5 glyphs of build string
                // at this size, and the string is what the row exists to show.
                "h-auto w-full min-w-0 justify-start rounded-md px-1 py-1.5 font-mono text-[10px] leading-none",
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
                <span className="truncate">{railLabel}</span>
              )}
            </Button>
          }
        />
        {/* AQU-2260: the hover only shows the build it copies, in full (the
            label is cut to the rail). The button's own words say "Copied". */}
        <TooltipContent side="right" className="max-w-xs whitespace-pre-wrap font-mono">
          {title}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/** Floating on other screens without chrome; inline inside an AuthPage footer. */
export function VersionBadge({ inline = false }: { inline?: boolean }) {
  return inline ? <InlineVersionBadge /> : <FloatingVersionBadge />
}

/** An auth-page footer's own copy; registers so the floating one stands down. */
function InlineVersionBadge() {
  useRegisterInFlowVersion()
  return <VersionBadgeBody inline />
}

function FloatingVersionBadge() {
  const { mounted } = useContext(InFlowVersionContext)
  if (mounted > 0) return null
  return <VersionBadgeBody inline={false} />
}

function VersionBadgeBody({ inline }: { inline: boolean }) {
  const t = useT()
  const identity = useBuildIdentity()
  const label = formatBuildLabel(identity)
  const title = formatBuildInfo(identity)
  const { copied, copy } = useCopyBuildInfo(title)

  return (
    <div className={cn(
      "flex items-center gap-1",
      inline ? "w-full flex-wrap justify-start" : "fixed bottom-3 start-3 z-30 max-w-[90vw]",
    )}>
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
          {title}
        </TooltipContent>
      </Tooltip>
      <UpdateIndicator className="bg-card px-2 py-1.5" />
    </div>
  )
}
