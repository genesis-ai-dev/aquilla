const STORAGE_KEY = "codex:analyticsEnabled"
const CHANGE_EVENT = "codex:analytics-consent-changed"

export function isAnalyticsEnabled(): boolean {
  if (typeof window === "undefined") return false
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw === null ? true : raw === "true"
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
