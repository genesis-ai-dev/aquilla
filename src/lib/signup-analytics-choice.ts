import { AUTH_BASE } from "./frontier/auth"
import { ANALYTICS_DISCLOSURE_VERSION } from "../../shared/analytics-consent"
const KEY = `aquilla:signup-analytics:${encodeURIComponent(AUTH_BASE)}`
export interface SignupAnalyticsChoice { allowed: boolean; version: string; revision: string }
let memory: SignupAnalyticsChoice | null = null
let storageUnavailable = false
export function readSignupAnalyticsChoice(): SignupAnalyticsChoice | null {
  if (storageUnavailable) return memory
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<SignupAnalyticsChoice>
    return value.version === ANALYTICS_DISCLOSURE_VERSION && typeof value.allowed === "boolean" && typeof value.revision === "string"
      ? value as SignupAnalyticsChoice : null
  } catch { storageUnavailable = true; return memory }
}
export function confirmSignupAnalyticsChoice(allowed: boolean): void {
  memory = { allowed, version: ANALYTICS_DISCLOSURE_VERSION, revision: crypto.randomUUID() }
  try { sessionStorage.setItem(KEY, JSON.stringify(memory)) } catch { storageUnavailable = true }
}
export function clearSignupAnalyticsChoice(): void {
  memory = null
  try { sessionStorage.removeItem(KEY) } catch { storageUnavailable = true }
}
