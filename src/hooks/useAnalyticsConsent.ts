import { useSyncExternalStore } from "react"
import { analyticsAccount } from "@/lib/analytics-account"

export function useAnalyticsConsent() {
  const state = useSyncExternalStore(analyticsAccount.subscribe, analyticsAccount.getSnapshot, analyticsAccount.getSnapshot)
  return {
    enabled: state.decision?.allowed === true && !state.blocked,
    disabled: !state.accountId || state.saving,
    saving: state.saving,
    retry: analyticsAccount.refresh,
    error: state.error,
    setEnabled: (next: boolean) => { void analyticsAccount.choose(next).catch(() => { /* rendered from state.error */ }) },
  }
}
