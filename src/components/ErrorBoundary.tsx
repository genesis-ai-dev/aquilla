/**
 * AQU-266: Global error boundary + crash telemetry.
 *
 * Wraps the router output so that any unhandled render throw shows a branded
 * recovery screen rather than a white screen of death. Also registers
 * window.onerror + unhandledrejection handlers that funnel uncaught errors into
 * posthog.captureException (consent-gated via the posthog module which already
 * respects isAnalyticsEnabled() on init and responds to onAnalyticsConsentChange).
 *
 * SWARM-TODO(AQU-266): UI-QA — force a render throw (e.g. via a dev-only query
 * param ?__crash=1 or React devtools) and confirm the branded recovery screen
 * appears (not a white screen) AND a PostHog "app_crash" exception event lands
 * in the PostHog event stream.
 */

import { Component, type ErrorInfo, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import posthog from "@/lib/posthog"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Dev-only crash trigger: appending ?__crash=1 to any URL while
// import.meta.env.DEV is true renders a component that immediately throws,
// letting you manually verify the boundary + PostHog telemetry without needing
// React DevTools or a production-style error injection.
// ---------------------------------------------------------------------------
function DevCrashTrigger() {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search)
    if (params.get("__crash") === "1") {
      throw new Error("[DEV] intentional crash triggered by ?__crash=1")
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Chunk-load recovery (RES-3 / audit QW-4): after a redeploy, stale lazy-route
// chunks 404 ("Failed to fetch dynamically imported module" etc.). One forced
// reload usually fixes it (the new HTML references the new chunk hashes). The
// sessionStorage flag guards against a reload loop on a genuinely broken
// deploy; it is re-armed on the next successful page load so a later deploy
// mid-session gets its own one-shot reload.
// ---------------------------------------------------------------------------
const CHUNK_LOAD_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "Importing a module script failed",
  "Loading chunk",
  "ChunkLoadError",
]

export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return CHUNK_LOAD_PATTERNS.some((p) => msg.includes(p))
}

export const CHUNK_RELOAD_KEY = "aq:chunk-reload-attempted"

/** True if this error triggered the one-shot reload (caller should bail). */
function maybeReloadForChunkError(err: unknown): boolean {
  if (!isChunkLoadError(err)) return false
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return false
    sessionStorage.setItem(CHUNK_RELOAD_KEY, "1")
  } catch {
    return false // sessionStorage unavailable — fall through to the error UI
  }
  window.location.reload()
  return true
}

// ---------------------------------------------------------------------------
// Window-level error handlers — registered once when the module first loads.
// Both forward to posthog.captureException; consent-gating is already baked
// into posthog.ts (opt_out_capturing_by_default + onAnalyticsConsentChange).
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
  window.addEventListener("error", (event: ErrorEvent) => {
    const err = event.error instanceof Error
      ? event.error
      : new Error(event.message || "Unknown window.onerror")
    posthog.captureException(err, { properties: { source: "window.onerror" } })
    maybeReloadForChunkError(err)
  })

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const err = event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason ?? "Unhandled promise rejection"))
    posthog.captureException(err, { properties: { source: "unhandledrejection" } })
    maybeReloadForChunkError(err)
  })

  // Re-arm the one-shot chunk reload once a page load has succeeded. Lazy
  // chunks load on navigation — after `load` — so clearing here cannot re-arm
  // a tight loop: each reload only re-arms once the page has fully booted.
  const clearChunkReloadFlag = () => {
    try {
      sessionStorage.removeItem(CHUNK_RELOAD_KEY)
    } catch {
      // sessionStorage unavailable — nothing to re-arm
    }
  }
  if (document.readyState === "complete") {
    clearChunkReloadFlag()
  } else {
    window.addEventListener("load", clearChunkReloadFlag, { once: true })
  }
}

// ---------------------------------------------------------------------------
// Fallback screen — styled to match existing empty-state pattern from
// CellAreaPlaceholder.tsx (centred icon + title + description + action button).
// Uses min-h-screen + document scroll per the scroll-model rule (not h-screen
// flex tricks) for the root boundary. `compact` renders the same content at
// h-full instead, for boundaries nested inside AppShell's bounded content
// card (AppShell.tsx) — a min-h-screen fallback there would blow past the
// card's rounded border.
// ---------------------------------------------------------------------------
function ErrorFallback({
  onReload,
  isChunkError,
  compact,
}: {
  onReload: () => void
  isChunkError?: boolean
  compact?: boolean
}) {
  return (
    <div className={cn("flex items-center justify-center p-8", compact ? "h-full" : "min-h-screen")}>
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <div className="text-muted-foreground">
          <AlertTriangle className="h-10 w-10" aria-hidden />
        </div>
        <h3 className="text-base font-medium">
          {isChunkError ? "App updated — reload needed" : "Something went wrong"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {isChunkError
            ? "A new version of the app was deployed. Your work is saved locally — reload to pick it up."
            : "An unexpected error occurred. Your work is saved locally — reload to continue."}
        </p>
        <div className="mt-2">
          <Button type="button" variant="outline" onClick={onReload}>
            Reload
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Class component — required by React for error boundaries.
// ---------------------------------------------------------------------------
interface Props {
  children: ReactNode
  /** Render the fallback at h-full instead of min-h-screen, for boundaries
   * nested inside bounded chrome (e.g. AppShell's main content card) rather
   * than at the app root. */
  compact?: boolean
}

interface State {
  hasError: boolean
  isChunkError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, isChunkError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, isChunkError: isChunkLoadError(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    posthog.captureException(error, {
      properties: {
        source: "react_error_boundary",
        componentStack: info.componentStack,
      },
    })
    // Stale-chunk render throws get one automatic reload before showing the
    // "App updated" fallback (see maybeReloadForChunkError above).
    maybeReloadForChunkError(error)
  }

  private handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          onReload={this.handleReload}
          isChunkError={this.state.isChunkError}
          compact={this.props.compact}
        />
      )
    }
    return (
      <>
        <DevCrashTrigger />
        {this.props.children}
      </>
    )
  }
}
