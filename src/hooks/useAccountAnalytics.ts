import { useSyncExternalStore, useMemo } from "react"
import { analyticsAccount } from "@/lib/analytics-account"
import posthog from "@/lib/posthog"

/** Old render callbacks retain their original account/approval generation. */
export function useAccountAnalytics() {
  const state = useSyncExternalStore(analyticsAccount.subscribe, analyticsAccount.getSnapshot, analyticsAccount.getSnapshot)
  return useMemo(() => posthog.scope(state.generation), [state])
}
