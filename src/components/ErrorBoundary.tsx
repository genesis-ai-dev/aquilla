// RES-3 (QW-4): Top-level error boundary. Catches render errors that would
// otherwise leave the user on a permanent white screen. Reports via PostHog
// and renders a minimal recovery UI. See docs/AUDIT-2026-06-10.md §3.3.

import { Component, type ErrorInfo, type ReactNode } from "react"
import posthog from "@/lib/posthog"

const CHUNK_LOAD_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "Importing a module script failed",
  "Loading chunk",
  "ChunkLoadError",
]

function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return CHUNK_LOAD_PATTERNS.some((p) => msg.includes(p))
}

const CHUNK_RELOAD_KEY = "aq:chunk-reload-attempted"

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  isChunkError: boolean
}

/**
 * Class component because `componentDidCatch` is only available on class
 * components (React 19 still doesn't expose it as a hook). Wraps the entire
 * application above the route Suspense so any render throw is caught here
 * rather than crashing the whole tab.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, isChunkError: false }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      isChunkError: isChunkLoadError(error),
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Never throw from here — a throw in componentDidCatch would swallow the
    // original error and leave the app in a partially recovered state.
    try {
      captureException(error, { extra: { componentStack: info.componentStack } })
    } catch {
      // Safety: if PostHog itself throws (opted-out, uninitialized, etc.) we
      // must not propagate — the boundary is already handling an error.
    }

    if (isChunkLoadError(error)) {
      // Guard against a broken deploy that 404s on every chunk: only reload once
      // per session so a genuinely broken deploy doesn't loop forever.
      if (!sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
        sessionStorage.setItem(CHUNK_RELOAD_KEY, "1")
        window.location.reload()
        return
      }
    }

    if (import.meta.env.DEV) {
      // In dev, surface the error loudly so DX isn't degraded.
      console.error("[ErrorBoundary] Caught render error:", error, info)
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const { isChunkError } = this.state

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <div className="max-w-md space-y-3">
          <h1 className="text-lg font-semibold text-foreground">
            {isChunkError ? "App updated — reload needed" : "Something went wrong"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isChunkError
              ? "A newer version of the app was deployed. Reload the page to get the latest."
              : "An unexpected error occurred. Reloading usually fixes it."}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}

/**
 * Safe PostHog exception capture. Works whether PostHog is initialized, opted
 * out, or the key is absent. Never throws.
 */
export function captureException(
  error: unknown,
  extra?: Record<string, unknown>,
): void {
  try {
    if (typeof posthog?.captureException === "function") {
      posthog.captureException(error, extra)
    } else if (typeof posthog?.capture === "function") {
      // Fallback: captureException may not exist in older posthog-js builds.
      posthog.capture("$exception", {
        $exception_message: error instanceof Error ? error.message : String(error),
        $exception_type: error instanceof Error ? error.constructor.name : typeof error,
        ...extra,
      })
    }
  } catch {
    // Safety: never throw from the error-reporting path.
  }
}
