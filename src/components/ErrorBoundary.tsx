/**
 * FRO-266: Global error boundary + crash telemetry.
 *
 * Wraps the router output so that any unhandled render throw shows a branded
 * recovery screen rather than a white screen of death. Also registers
 * window.onerror + unhandledrejection handlers that funnel uncaught errors into
 * posthog.captureException (consent-gated via the posthog module which already
 * respects isAnalyticsEnabled() on init and responds to onAnalyticsConsentChange).
 *
 * SWARM-TODO(FRO-266): UI-QA — force a render throw (e.g. via a dev-only query
 * param ?__crash=1 or React devtools) and confirm the branded recovery screen
 * appears (not a white screen) AND a PostHog "app_crash" exception event lands
 * in the PostHog event stream.
 */

import { Component, type ErrorInfo, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import posthog from "@/lib/posthog"

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
  })

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const err = event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason ?? "Unhandled promise rejection"))
    posthog.captureException(err, { properties: { source: "unhandledrejection" } })
  })
}

// ---------------------------------------------------------------------------
// Fallback screen — styled to match existing empty-state pattern from
// CellAreaPlaceholder.tsx (centred icon + title + description + action button).
// Uses min-h-screen + document scroll per the scroll-model rule (not h-screen
// flex tricks).
// ---------------------------------------------------------------------------
function ErrorFallback({ onReload }: { onReload: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <div className="text-muted-foreground">
          <AlertTriangle className="h-10 w-10" aria-hidden />
        </div>
        <h3 className="text-base font-medium">Something went wrong</h3>
        <p className="text-sm text-muted-foreground">
          An unexpected error occurred. Your work is saved locally — reload to
          continue.
        </p>
        <div className="mt-2">
          <button
            type="button"
            onClick={onReload}
            className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-sm shadow-neu-sm transition-all hover:shadow-neu active:shadow-neu-pressed"
          >
            Reload
          </button>
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
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(_: Error): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    posthog.captureException(error, {
      properties: {
        source: "react_error_boundary",
        componentStack: info.componentStack,
      },
    })
  }

  private handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback onReload={this.handleReload} />
    }
    return (
      <>
        <DevCrashTrigger />
        {this.props.children}
      </>
    )
  }
}
