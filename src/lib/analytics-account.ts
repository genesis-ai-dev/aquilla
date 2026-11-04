import { onAnalyticsBoundary } from "./analytics-boundary"
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
  blocked: boolean
}
const initial = (): AnalyticsAccountState => ({ generation: 0, accountId: null, username: null, decision: null, ready: false, saving: false, error: false, blocked: false })

/** Isolated state machine; no SDK, optional persistence or collection lives here. */
export class AnalyticsAccount {
  private state = initial()
  private session: FrontierSession | null = null
  private listeners = new Set<() => void>()
  private request: AbortController | null = null
  private suppressed = new Set<string>()
  private verifiedAt = 0
  onDecision: ((id: string, blocked: boolean) => void) | undefined
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
  invalidate = () => {
    this.session = null
    this.suspend()
    this.publish({ accountId: null, username: null, decision: null })
  }
  eligible = () => this.state.ready && !this.state.saving && !!this.state.accountId &&
    this.state.decision?.allowed === true && !!this.session && !isJwtExpired(this.session.jwt) &&
    navigator.onLine && !document.hidden && Date.now() - this.verifiedAt < 75_000

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
      this.verifiedAt = Date.now()
      const blocked = this.isSuppressed(result.accountId)
      this.publish({ accountId: result.accountId, decision: result.decision, ready: !blocked, blocked, error: false })
    } catch {
      if (generation === this.state.generation) this.publish({ error: true })
    }
  }
  refresh = () => this.activate(this.session)
  async revalidate(): Promise<void> {
    if (this.state.saving) return
    if (!this.state.ready || !this.session) return this.refresh()
    const generation = this.state.generation
    const session = this.session
    const controller = new AbortController()
    this.request = controller
    try {
      const result = await this.requestJson(session.jwt, controller.signal)
      if (generation !== this.state.generation) return
      if (result.accountId !== this.state.accountId || result.decision?.revision !== this.state.decision?.revision || this.isSuppressed(result.accountId)) {
        await this.activate(session)
      } else this.verifiedAt = Date.now()
    } catch {
      if (generation === this.state.generation) {
        this.suspend()
        this.publish({ error: true })
      }
    }
  }
  refreshIfSession = (jwt: string) => this.session?.jwt === jwt ? this.refresh() : Promise.resolve()
  private suppressionKey(id: string) { return `aquilla:analytics-denied:${encodeURIComponent(AUTH_BASE)}:${id}` }
  private isSuppressed(id: string): boolean {
    if (this.suppressed.has(id)) return true
    try {
      return localStorage.getItem(this.suppressionKey(id)) === "true" || (localStorage.getItem("aquilla:analyticsEnabled") === "false" && localStorage.getItem(`${this.suppressionKey(id)}:confirmed`) !== "true")
    } catch { return true }
  }
  receiveDecisionHint(id: string, blocked: boolean): void {
    if (blocked) this.suppressed.add(id)
    else this.suppressed.delete(id)
    if (this.state.accountId === id) void this.refresh()
  }
  /** Only after a successful authenticated preference write; never a yes cache. */
  recordConfirmedChoice(id: string, allowed: boolean): void {
    if (allowed) this.suppressed.delete(id)
    else this.suppressed.add(id)
    try {
      if (allowed) {
        localStorage.removeItem(this.suppressionKey(id))
        localStorage.setItem(`${this.suppressionKey(id)}:confirmed`, "true")
      } else localStorage.setItem(this.suppressionKey(id), "true")
    } catch { /* memory protects this session; the next hydration fails closed */ }
    this.onDecision?.(id, !allowed)
  }
  async choose(allowed: boolean, source: "signup" | "settings" = "settings"): Promise<void> {
    const session = this.session
    const { accountId, decision } = this.state
    this.suspend()
    if (!session || !accountId) throw new Error("Sign in and load your sharing preference first.")
    // A refusal wins locally even when saving fails or the browser goes offline.
    this.suppressed.add(accountId)
    this.onDecision?.(accountId, true)
    try { localStorage.setItem(this.suppressionKey(accountId), "true") } catch { /* memory keeps refusal */ }
    this.publish({ saving: true, blocked: true, error: false })
    const generation = this.state.generation
    const controller = new AbortController()
    this.request = controller
    try {
      const result = await this.requestJson(session.jwt, controller.signal, {
        allowed, source, disclosureVersion: ANALYTICS_DISCLOSURE_VERSION, expectedRevision: decision?.revision ?? null,
      })
      if (generation !== this.state.generation) return
      if (result.accountId !== accountId || result.decision?.allowed !== allowed) throw new Error("Sharing response did not match the active account")
      this.recordConfirmedChoice(accountId, allowed)
      this.verifiedAt = Date.now()
      this.publish({ decision: result.decision, blocked: !allowed, ready: true, saving: false })
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
onAnalyticsBoundary(analyticsAccount.invalidate)
if (typeof window !== "undefined") {
  try {
    const channel = new BroadcastChannel(`aquilla:analytics:${AUTH_BASE}`)
    analyticsAccount.onDecision = (id, blocked) => {
      try { channel.postMessage({ id, blocked }) } catch { /* local suppression and server revalidation remain effective */ }
    }
    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const data = event.data as { id?: unknown; blocked?: unknown } | null
      if (data && typeof data.id === "string" && typeof data.blocked === "boolean") analyticsAccount.receiveDecisionHint(data.id, data.blocked)
    })
  } catch { /* storage events and server revalidation remain available */ }
  window.addEventListener("offline", analyticsAccount.suspend)
  window.addEventListener("online", () => { void analyticsAccount.refresh() })
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) analyticsAccount.suspend()
    else void analyticsAccount.refresh()
  })
  window.addEventListener("storage", (event) => {
    if (event.key?.startsWith("aquilla:analytics")) void analyticsAccount.refresh()
  })
  // Expired sessions stop even without another UI interaction. Revalidate server
  // decisions periodically; an offline or hidden tab never collects.
  let lastCheck = Date.now()
  window.setInterval(() => {
    if (analyticsAccount.getSnapshot().ready && analyticsAccount.getSnapshot().decision?.allowed && !analyticsAccount.eligible()) analyticsAccount.suspend()
    if (!document.hidden && navigator.onLine && Date.now() - lastCheck >= 60_000) {
      lastCheck = Date.now()
      void analyticsAccount.revalidate()
    }
  }, 1_000)
}

/** The draft is bound to the JWT returned by registration, never whichever
 * account became active while that registration request was in flight. */
export async function confirmNewAccountAnalytics(jwt: string, allowed: boolean): Promise<void> {
  const result = await requestConsent(jwt, new AbortController().signal, {
    allowed, source: "signup", disclosureVersion: ANALYTICS_DISCLOSURE_VERSION, expectedRevision: null,
  })
  if (result.decision?.allowed !== allowed) throw new Error("Sharing response did not match the confirmed choice")
  analyticsAccount.recordConfirmedChoice(result.accountId, allowed)
  await analyticsAccount.refreshIfSession(jwt)
}
