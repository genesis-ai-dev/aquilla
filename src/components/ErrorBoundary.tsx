/**
 * AQU-266: Global error boundary + crash telemetry.
 *
 * Wraps the router output so that any unhandled render throw shows a branded
 * recovery screen rather than a white screen of death, and reports the throw
 * via posthog.captureException (consent-gated via the posthog module which
 * already respects isAnalyticsEnabled() on init and responds to
 * onAnalyticsConsentChange). Also registers window error + unhandledrejection
 * handlers for chunk-reload recovery; uncaught errors reach PostHog through its
 * own exception autocapture (AQU-1572, see the handlers below).
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
import { isTauriRuntime } from "@/lib/offline/is-tauri"

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
// They exist for chunk-reload recovery, which must run on every uncaught error.
//
// AQU-1572: on the web they no longer report to PostHog. posthog.ts inits with
// `capture_exceptions: true`, which wraps window.onerror and
// window.onunhandledrejection itself, so a capture here sent every uncaught
// error twice.
//
// The desktop shell is the exception. posthog-js lazy-loads that autocapture
// from its CDN as a <script>, and the shell's CSP (`script-src 'self'` in
// src-tauri/tauri.conf.json) blocks it, so autocapture never starts there and
// these handlers are the only capture. Consent-gating is baked into posthog.ts
// either way (opt_out_capturing_by_default + onAnalyticsConsentChange).
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
  window.addEventListener("error", (event: ErrorEvent) => {
    const err = event.error instanceof Error
      ? event.error
      : new Error(event.message || "Unknown window.onerror")
    if (isTauriRuntime()) posthog.captureException(err, { source: "window.onerror" })
    recoverFromChunkError(err)
  })

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const err = event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason ?? "Unhandled promise rejection"))
    if (isTauriRuntime()) posthog.captureException(err, { source: "unhandledrejection" })
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
  /**
   * AQU-849: render a local fallback instead of the full-screen recovery UI.
   * Used by side panels, where a render throw must stay inside the panel and
   * must not push the user into a page reload — calling `reset` clears the
   * boundary so the subtree remounts and refetches in place.
   */
  fallback?: (reset: () => void) => ReactNode
  /** Names this boundary in crash telemetry, so ops can tell which surface
   * threw (the 2026-08-10 pane crash was reported with no error text). */
  label?: string
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
    // Not a duplicate of PostHog's autocapture (AQU-1572): React 19 reports an
    // error a boundary caught to console.error, never to window.onerror, and
    // `capture_exceptions: true` leaves console errors alone — so this is the
    // only capture of a render throw. The second argument is the event's
    // property bag itself; wrapping it in `{ properties: … }` filed all three
    // under one nested `properties` key instead of as event properties.
    posthog.captureException(error, {
      source: "react_error_boundary",
      boundary: this.props.label ?? "root",
      componentStack: info.componentStack,
    })
    // Stale-chunk render throws get one automatic reload before showing the
    // "App updated" fallback (see @/lib/chunk-reload).
    recoverFromChunkError(error)
  }

  private handleReload = () => {
    window.location.reload()
  }

  /** Clears the boundary so the subtree remounts — the in-place recovery a
   * panel-level fallback offers instead of a page reload. */
  private handleReset = () => {
    this.setState({ hasError: false, isChunkError: false })
  }

  render() {
    if (this.state.hasError) {
      // A stale-chunk error is only fixable by reloading, so local fallbacks
      // still defer to the full recovery screen for that one case.
      if (this.props.fallback && !this.state.isChunkError) {
        return this.props.fallback(this.handleReset)
      }
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
