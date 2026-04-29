import { useEffect, useState } from "react"
import {
  isAnalyticsEnabled,
  setAnalyticsEnabled,
  onAnalyticsConsentChange,
} from "@/lib/analytics-consent"

export function useAnalyticsConsent(): {
  enabled: boolean
  setEnabled: (next: boolean) => void
} {
  const [enabled, setEnabled] = useState<boolean>(() => isAnalyticsEnabled())

  useEffect(() => onAnalyticsConsentChange(setEnabled), [])

  return {
    enabled,
    setEnabled: (next) => setAnalyticsEnabled(next),
  }
}
