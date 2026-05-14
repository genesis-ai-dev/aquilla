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
    disable_session_recording: true,
    opt_out_capturing_by_default: !isAnalyticsEnabled(),
  })

  onAnalyticsConsentChange((enabled) => {
    if (enabled) posthog.opt_in_capturing()
    else posthog.opt_out_capturing()
  })
}

export default posthog
