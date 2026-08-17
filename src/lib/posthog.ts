import posthog from "posthog-js"
import { isAnalyticsEnabled, onAnalyticsConsentChange } from "@/lib/analytics-consent"

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com"

if (typeof window !== "undefined" && KEY) {
  posthog.init(KEY, {
    api_host: HOST,
    persistence: "localStorage+cookie",
    capture_pageview: true,
    autocapture: false,
    // Surface unhandled errors / rejections as $exception events so failures
    // that never reach an explicit captureException call are still queryable.
    capture_exceptions: true,
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
