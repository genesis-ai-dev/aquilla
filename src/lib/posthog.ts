import posthog from "posthog-js"
import { isAnalyticsEnabled, onAnalyticsConsentChange } from "@/lib/analytics-consent"
import { resolveAppEnv } from "@/lib/analytics-env"
import { dropNoisyExceptions } from "@/lib/analytics-exception-filter"
import { redactCaptureEvent } from "@/lib/analytics-redaction"
import { resolvePosthogHost } from "@/lib/posthog-host"

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
// AQU-854: EU Cloud by default — see `posthog-host.ts` for why US is not a
// legal fallback. Override with `VITE_POSTHOG_HOST=https://eu.i.posthog.com`.
const HOST = resolvePosthogHost(import.meta.env.VITE_POSTHOG_HOST as string | undefined)

if (typeof window !== "undefined" && KEY) {
  posthog.init(KEY, {
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
    // no capture site has to remember to do it.
    //
    // AQU-1572: `dropNoisyExceptions` runs first and discards `$exception`
    // noise (the benign ResizeObserver loop warning, and anything captured on
    // a localhost build). posthog-js runs the array in order and stops at the
    // first null, and redaction stays last so nothing after it can put a URL
    // back.
    before_send: [dropNoisyExceptions, redactCaptureEvent],
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

  onAnalyticsConsentChange((enabled) => {
    if (enabled) {
      posthog.opt_in_capturing()
      posthog.startSessionRecording()
    } else {
      posthog.opt_out_capturing()
      posthog.stopSessionRecording()
    }
  })
}

export default posthog
