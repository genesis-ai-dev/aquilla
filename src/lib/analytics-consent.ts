const STORAGE_KEY = "aquilla:analyticsEnabled"
const CHANGE_EVENT = "aquilla:analytics-consent-changed"

// Retain the last known choice when browser persistence is unavailable.
// An unsuccessful write must take precedence over a stale persisted value.
let memoryChoice: string | null = null
let unpersistedChoice = false

function readChoice(): string | null {
  if (unpersistedChoice) return memoryChoice
  try {
    memoryChoice = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    // Storage can be denied even when the browser exposes localStorage.
  }
  return memoryChoice
}

export function isAnalyticsEnabled(): boolean {
  if (typeof window === "undefined") return false
  const raw = readChoice()
  return raw === null ? true : raw === "true"
}

/**
 * True once the user has made an explicit analytics choice (the key exists in
 * localStorage). Distinct from isAnalyticsEnabled(), which returns true when no choice
 * has been recorded yet. Used to skip the onboarding
 * privacy step on subsequent runs.
 */
export function hasAnalyticsConsentBeenSet(): boolean {
  if (typeof window === "undefined") return false
  return readChoice() !== null
}

export function setAnalyticsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return
  memoryChoice = enabled ? "true" : "false"
  try {
    window.localStorage.setItem(STORAGE_KEY, memoryChoice)
    unpersistedChoice = false
  } catch {
    unpersistedChoice = true
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: enabled }))
}

export function onAnalyticsConsentChange(handler: (enabled: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (e: Event) => handler((e as CustomEvent<boolean>).detail)
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}
