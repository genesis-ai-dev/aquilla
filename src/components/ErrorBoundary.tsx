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
import { useT } from "@/lib/i18n/I18nProvider"
import { isChunkLoadError, recoverFromChunkError } from "@/lib/chunk-reload"

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
// Chunk-load recovery (RES-3 / audit QW-4 / AQU-1405): after a redeploy, stale
// lazy-route chunks 404 ("Failed to fetch dynamically imported module" etc.).
// One forced reload fixes it — the new HTML references the new chunk hashes.
// The guard, the "Updating …" notice, and the per-chunk one-shot rule live in
// src/lib/chunk-reload.ts so the window-level handlers below and the boundary
// share exactly one implementation.
// ---------------------------------------------------------------------------

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
    recoverFromChunkError(err)
  })

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const err = event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason ?? "Unhandled promise rejection"))
    posthog.captureException(err, { properties: { source: "unhandledrejection" } })
    recoverFromChunkError(err)
  })
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
  const t = useT()
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
            {t("workspace.errorBoundary.reload")}
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
    // "App updated" fallback (see @/lib/chunk-reload).
    recoverFromChunkError(error)
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
