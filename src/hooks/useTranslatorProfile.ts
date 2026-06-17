import { useEffect, useState } from "react"
import {
  getTranslatorProfile,
  setTranslatorProfile,
  onTranslatorProfileChange,
  type TranslatorProfile,
} from "@/lib/translator-profile"

/**
 * React binding for the user-level translator profile. Mirrors
 * useAnalyticsConsent — reads the current value on mount and re-renders when any
 * instance in the tab writes a change (via the module's CustomEvent).
 */
export function useTranslatorProfile(): {
  profile: TranslatorProfile
  setProfile: (next: TranslatorProfile) => void
} {
  const [profile, setProfile] = useState<TranslatorProfile>(() => getTranslatorProfile())

  useEffect(() => onTranslatorProfileChange(setProfile), [])

  return {
    profile,
    setProfile: (next) => setTranslatorProfile(next),
  }
}
