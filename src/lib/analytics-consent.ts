const STORAGE_KEY = "codex:analyticsEnabled"
const CHANGE_EVENT = "codex:analytics-consent-changed"

export function isAnalyticsEnabled(): boolean {
  if (typeof window === "undefined") return false
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw === null ? true : raw === "true"
}

/**
 * True once the user has made an explicit analytics choice (the key exists in
 * localStorage). Distinct from isAnalyticsEnabled(), which returns true (the
 * default) when no choice has been recorded yet. Used to skip the onboarding
 * privacy step on subsequent runs.
 */
export function hasAnalyticsConsentBeenSet(): boolean {
  if (typeof window === "undefined") return false
  return window.localStorage.getItem(STORAGE_KEY) !== null
}

export function setAnalyticsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false")
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: enabled }))
}

export function onAnalyticsConsentChange(handler: (enabled: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (e: Event) => handler((e as CustomEvent<boolean>).detail)
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}
