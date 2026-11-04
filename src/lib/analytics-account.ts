import { AUTH_BASE, isJwtExpired } from "@/lib/frontier/auth"
import type { FrontierSession } from "@/lib/frontier/types"
import { ANALYTICS_DISCLOSURE_VERSION, parseAnalyticsDecision, type AnalyticsConsentResponse } from "../../shared/analytics-consent"

export interface AnalyticsAccountState {
  generation: number
  accountId: string | null
  username: string | null
  decision: AnalyticsConsentResponse["decision"]
  ready: boolean
  saving: boolean
  error: boolean
}
const initial = (): AnalyticsAccountState => ({ generation: 0, accountId: null, username: null, decision: null, ready: false, saving: false, error: false })

/** Isolated state machine; no SDK, optional persistence or collection lives here. */
export class AnalyticsAccount {
  private state = initial()
  private session: FrontierSession | null = null
  private listeners = new Set<() => void>()
  private request: AbortController | null = null
  private suppressed = new Set<string>()
  private requestJson: typeof requestConsent
  constructor(requestJson: typeof requestConsent = requestConsent) { this.requestJson = requestJson }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(update: Partial<AnalyticsAccountState>) {
    this.state = { ...this.state, ...update }
    for (const listener of this.listeners) listener()
  }
  suspend = () => {
    this.request?.abort()
    this.request = null
    this.publish({ generation: this.state.generation + 1, ready: false, saving: false })
  }
  eligible = () => this.state.ready && !this.state.saving && !!this.state.accountId &&
    this.state.decision?.allowed === true && !!this.session && !isJwtExpired(this.session.jwt) &&
    navigator.onLine && !document.hidden

  async activate(session: FrontierSession | null): Promise<void> {
    this.suspend()
    this.session = session
    this.publish({ accountId: null, username: session?.username ?? null, decision: null, error: false })
    if (!session || isJwtExpired(session.jwt) || !navigator.onLine) return
    const generation = this.state.generation
    const controller = new AbortController()
    this.request = controller
    try {
      const result = await this.requestJson(session.jwt, controller.signal)
      if (generation !== this.state.generation) return
      const blocked = this.isSuppressed(result.accountId)
      this.publish({ accountId: result.accountId, decision: result.decision, ready: !blocked, error: false })
    } catch {
      if (generation === this.state.generation) this.publish({ error: true })
    }
  }
  refresh = () => this.activate(this.session)
  private suppressionKey(id: string) { return `aquilla:analytics-denied:${encodeURIComponent(AUTH_BASE)}:${id}` }
  private isSuppressed(id: string): boolean {
    if (this.suppressed.has(id)) return true
    try {
      return localStorage.getItem(this.suppressionKey(id)) === "true" || (localStorage.getItem("aquilla:analyticsEnabled") === "false" && localStorage.getItem(`${this.suppressionKey(id)}:confirmed`) !== "true")
    } catch { return true }
  }
  async choose(allowed: boolean, source: "signup" | "settings" = "settings"): Promise<void> {
    const session = this.session
    const { accountId, decision } = this.state
    this.suspend()
    if (!session || !accountId) throw new Error("Sign in and load your sharing preference first.")
    // A refusal wins locally even when saving fails or the browser goes offline.
    this.suppressed.add(accountId)
    try { localStorage.setItem(this.suppressionKey(accountId), "true") } catch { /* memory keeps refusal */ }
    this.publish({ saving: true, error: false })
    const generation = this.state.generation
    const controller = new AbortController()
    this.request = controller
    try {
      const result = await this.requestJson(session.jwt, controller.signal, {
        allowed, source, disclosureVersion: ANALYTICS_DISCLOSURE_VERSION, expectedRevision: decision?.revision ?? null,
      })
      if (generation !== this.state.generation) return
      if (result.accountId !== accountId || result.decision?.allowed !== allowed) throw new Error("Sharing response did not match the active account")
      if (allowed) {
        this.suppressed.delete(accountId)
        try {
          localStorage.removeItem(this.suppressionKey(accountId))
          // A fresh confirmation supersedes the old browser-wide refusal only
          // for this account. This marker alone can never enable collection.
          localStorage.setItem(`${this.suppressionKey(accountId)}:confirmed`, "true")
        } catch { /* no persistent yes cache; next hydration fails closed */ }
      }
      this.publish({ decision: result.decision, ready: true, saving: false })
    } catch (error) {
      if (generation === this.state.generation) this.publish({ saving: false, error: true, ready: false })
      throw error
    }
  }
}

async function requestConsent(jwt: string, signal: AbortSignal, body?: Record<string, unknown>): Promise<AnalyticsConsentResponse> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) controller.abort()
  const timer = setTimeout(abort, 15_000)
  try {
    const res = await fetch(`${AUTH_BASE}/api/v2/auth/me/analytics-consent`, {
      method: body ? "PUT" : "GET", cache: "no-store", signal: controller.signal,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) throw new Error(`Sharing preference request failed (${res.status})`)
    const data = await res.json() as AnalyticsConsentResponse
    if (typeof data.accountId !== "string" || !data.accountId) throw new Error("Invalid sharing account")
    return { accountId: data.accountId, decision: parseAnalyticsDecision(data.decision) }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}
export const analyticsAccount = new AnalyticsAccount()
