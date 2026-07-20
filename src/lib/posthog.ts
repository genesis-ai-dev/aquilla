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
      // Translators' draft text is user content but not credentials; keep the
      // page visible so replays are actually diagnosable. Inputs are masked —
      // passwords, emails, invite tokens all enter through inputs.
      maskAllInputs: true,
      maskTextSelector: "[data-ph-mask]",
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
