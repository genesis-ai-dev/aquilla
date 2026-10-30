import type { PostHog } from "posthog-js"
import { isAnalyticsEnabled, onAnalyticsConsentChange } from "@/lib/analytics-consent"
import { resolveAppEnv } from "@/lib/analytics-env"
import { installResizeObserverNoiseGuard } from "@/lib/analytics-noise"
import { redactCaptureEvent } from "@/lib/analytics-redaction"
import { resolvePosthogHost } from "@/lib/posthog-host"

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
// AQU-854: EU Cloud by default — see `posthog-host.ts` for why US is not a
// legal fallback. Override with `VITE_POSTHOG_HOST=https://eu.i.posthog.com`.
const HOST = resolvePosthogHost(import.meta.env.VITE_POSTHOG_HOST as string | undefined)

// AQU-2093: posthog-js (~280 KB) is no longer part of the first load. This
// module hands out a small stand-in at once; the library loads after the page
// has finished loading and the browser is idle, then receives every call made
// meanwhile, in order. Errors thrown before it arrives are held and reported as
// soon as it does, so the first seconds of a visit are still covered.
type Call = (instance: PostHog) => void
const pending: Call[] = []
let loaded: PostHog | null = null

function whenLoaded(call: Call): void {
  if (loaded) call(loaded)
  else pending.push(call)
}

const posthog = {
  capture: (...args: Parameters<PostHog["capture"]>): void => whenLoaded((ph) => void ph.capture(...args)),
  captureException: (...args: Parameters<PostHog["captureException"]>): void =>
    whenLoaded((ph) => void ph.captureException(...args)),
  identify: (...args: Parameters<PostHog["identify"]>): void => whenLoaded((ph) => ph.identify(...args)),
  register: (...args: Parameters<PostHog["register"]>): void => whenLoaded((ph) => ph.register(...args)),
  reset: (...args: Parameters<PostHog["reset"]>): void => whenLoaded((ph) => ph.reset(...args)),
  /** Undefined until the library has loaded (and while recording is off). */
  get_session_replay_url: (...args: Parameters<PostHog["get_session_replay_url"]>): string | undefined =>
    loaded?.get_session_replay_url(...args),
}

/** Errors thrown before the library arrives; PostHog's own handlers take over after. */
function holdEarlyErrors(win: Window): (ph: PostHog) => void {
  const early: unknown[] = []
  const onError = (event: ErrorEvent) => early.push(event.error ?? event.message)
  const onRejection = (event: PromiseRejectionEvent) => early.push(event.reason)
  win.addEventListener("error", onError)
  win.addEventListener("unhandledrejection", onRejection)
  return (ph) => {
    win.removeEventListener("error", onError)
    win.removeEventListener("unhandledrejection", onRejection)
    for (const error of early) ph.captureException(error)
  }
}

function afterPageLoad(win: Window, start: () => void): void {
  const whenIdle = () =>
    typeof win.requestIdleCallback === "function" ? win.requestIdleCallback(start, { timeout: 3000 }) : win.setTimeout(start, 1)
  if (win.document.readyState === "complete") whenIdle()
  else win.addEventListener("load", whenIdle, { once: true })
}

if (typeof window !== "undefined" && KEY) {
  // AQU-1572: ahead of init, so the benign ResizeObserver message never reaches
  // the exception rate limiter that real errors share. The `$exception` noise
  // filter itself runs inside `redactCaptureEvent` below; this guard is the
  // part a `before_send` hook cannot do (see analytics-noise.ts).
  installResizeObserverNoiseGuard(window)
  const reportEarlyErrors = holdEarlyErrors(window)
  afterPageLoad(window, () => {
    void import("posthog-js").then(({ default: posthog }) => {
      initPosthog(posthog, KEY)
      loaded = posthog
      reportEarlyErrors(posthog)
      for (const call of pending.splice(0)) call(posthog)
    })
  })

  onAnalyticsConsentChange((enabled) => {
    whenLoaded((ph) => {
      if (enabled) {
        ph.opt_in_capturing()
        ph.startSessionRecording()
      } else {
        ph.opt_out_capturing()
        ph.stopSessionRecording()
      }
    })
  })
}

function initPosthog(posthog: PostHog, key: string): void {
  posthog.init(key, {
    api_host: HOST,
    persistence: "localStorage+cookie",
    capture_pageview: true,
    autocapture: false,
    // Surface unhandled errors / rejections as $exception events so failures
    // that never reach an explicit captureException call are still queryable.
    // AQU-1572: this wraps window.onerror and window.onunhandledrejection
    // itself, so it is the only window-level capture on the web — the
    // ErrorBoundary listeners no longer report there (see ErrorBoundary.tsx
    // for the desktop shell, where this cannot load).
    capture_exceptions: true,
    // OPS-29 (docs/OPSEC-REVIEW-2026-09-14.md): the last hook before an event
    // leaves the browser. `/join/:token`, `/join-org/:token`, `/link/:token`,
    // `/reset-password?token=` and `/verify-email?token=` all carry a live
    // credential in the URL, and PostHog attaches `$current_url`/`$pathname` to
    // every event (plus the replay's own rrweb `href` and the `$initial_*`
    // person properties). Redact by route position and query-parameter name so
    // no capture site has to remember to do it. AQU-1572's `$exception` noise
    // filter composes inside it (analytics-noise.ts).
    before_send: redactCaptureEvent,
    disable_session_recording: !isAnalyticsEnabled(),
    session_recording: {
      // Keep the page visible so replays are actually diagnosable. Inputs are
      // masked — passwords, emails and invite tokens all enter through inputs.
      maskAllInputs: true,
      // OPS-3 (docs/OPSEC-REVIEW-2026-08-13.md): `maskAllInputs` never covered
      // the thing most worth covering. The cell editor is a contenteditable,
      // not an <input>, so unpublished draft translations — and the source
      // text beside them, which names the passage and therefore the project —
      // were replayed verbatim into a third-party US processor. For a team
      // translating in a jurisdiction where the work is dangerous, a replay
      // that shows *which* text is being worked on is a bigger disclosure than
      // anything in the analytics events.
      //
      // `[data-cell-type]` is the source and target column wrappers in
      // EditorTable, so this masks every render variant of cell text — rich
      // HTML, plain, USFM, IDML, and the live editor — in one selector rather
      // than one component at a time. `[data-ph-mask]` stays for everything
      // else that opts in (comment bodies, the source rich-text surface).
      maskTextSelector: "[data-ph-mask], [data-cell-type]",
    },
    opt_out_capturing_by_default: !isAnalyticsEnabled(),
  })

  // AQU-1572: one project key serves every build, so stamp each event with the
  // deployment it came from — production / dev / preview / local / desktop —
  // for dashboards to split on. `posthog.reset()` clears super-properties, so
  // logout registers it again (useFrontierSession.ts).
  posthog.register({ app_env: resolveAppEnv(window.location) })
}

export default posthog
