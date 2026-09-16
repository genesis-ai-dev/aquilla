import { openDB } from "idb"
import type { FrontierSession } from "./types"

const DB = "frontier"
const STORE = "session"
const ENVELOPE_KEY = "envelope"
const LEGACY_KEY = "current"

interface Envelope {
  active: string | null
  sessions: Record<string, FrontierSession>
  /** Last account whose client data boundary was fully prepared and published.
   * Undefined is the one-time pre-boundary upgrade state. */
  dataOwner?: string | null
}

async function db() {
  return openDB(DB, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    },
  })
}

type Listener = () => void
const listeners = new Set<Listener>()
function notify() { for (const l of listeners) l() }

// Monotonic within this tab. It advances for both local writes and cross-tab
// pings so async auth checks can prove that no session mutation landed between
// reading IndexedDB and acting on that result.
let sessionRevision = 0

export function getSessionRevision(): number {
  return sessionRevision
}

// Cross-tab reconciliation (FRO-367). The session lives in IndexedDB, which
// (unlike localStorage) emits no cross-tab events, so signing into account B
// in one tab left every other tab showing account A — and an org switcher
// listing orgs the now-active account can't access — until a manual reload.
// We ping a localStorage key on every write; other tabs hear the `storage`
// event and re-run notify(), which drives the same re-read path the writing
// tab already uses (useAccounts → useFrontierSession → OrgContext). The
// browser never delivers `storage` to the writer, so there's no echo, and
// notify() performs no writes, so there's no loop. Mirrors the existing
// cross-tab pattern in lib/store/user-api-keys.ts.
const PING_KEY = "frontier:session-ping"
const CHANNEL_NAME = "frontier:session"
const seenCrossTabPings = new Set<string>()
let crossTabChannel: BroadcastChannel | null = null
let externalReconcileQueued = false

function scheduleExternalReconcile(): void {
  if (externalReconcileQueued) return
  externalReconcileQueued = true
  queueMicrotask(() => {
    externalReconcileQueued = false
    sessionRevision += 1
    notify()
  })
}

function receiveCrossTabPing(ping: string | null): void {
  if (ping) {
    if (seenCrossTabPings.has(ping)) return
    seenCrossTabPings.add(ping)
    if (seenCrossTabPings.size > 64) {
      const oldest = seenCrossTabPings.values().next().value
      if (oldest) seenCrossTabPings.delete(oldest)
    }
  }
  scheduleExternalReconcile()
}

function pingOtherTabs(): void {
  ensureCrossTabListener()
  const ping = `${Date.now()}:${crypto.randomUUID()}`
  try {
    crossTabChannel?.postMessage(ping)
  } catch {
    // The storage ping below remains available for mixed-version/blocked BC.
  }
  try {
    localStorage.setItem(PING_KEY, ping)
  } catch {
    // BroadcastChannel and focus/visibility reconciliation still cover modern
    // browsers when localStorage is blocked (private or hardened profiles).
  }
}

let crossTabInstalled = false
function ensureCrossTabListener(): void {
  if (crossTabInstalled || typeof window === "undefined") return
  crossTabInstalled = true
  try {
    if (typeof window.BroadcastChannel === "function") {
      crossTabChannel = new window.BroadcastChannel(CHANNEL_NAME)
      crossTabChannel.addEventListener("message", (event) => {
        receiveCrossTabPing(typeof event.data === "string" ? event.data : null)
      })
    }
  } catch {
    crossTabChannel = null
  }
  window.addEventListener("storage", (e) => {
    if (e.key === PING_KEY) {
      receiveCrossTabPing(e.newValue)
    }
  })
  // Recover even when both messaging mechanisms were unavailable or a tab was
  // suspended while events fired. The subscriber re-reads IndexedDB on resume.
  window.addEventListener("focus", () => receiveCrossTabPing(null))
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") receiveCrossTabPing(null)
  })
}

export function subscribeSession(listener: Listener): () => void {
  ensureCrossTabListener()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function sessionKey(s: FrontierSession): string {
  return s.username
}

async function readEnvelope(): Promise<Envelope> {
  const d = await db()
  const existing = (await d.get(STORE, ENVELOPE_KEY)) as Envelope | undefined
  if (existing) return existing
  const legacy = (await d.get(STORE, LEGACY_KEY)) as FrontierSession | undefined
  if (legacy) {
    const key = sessionKey(legacy)
    const envelope: Envelope = { active: key, sessions: { [key]: legacy } }
    await d.put(STORE, envelope, ENVELOPE_KEY)
    await d.delete(STORE, LEGACY_KEY)
    return envelope
  }
  return { active: null, sessions: {} }
}

// ---- auth-hint cookie ----
// A non-credential, host-only 1-bit cookie used by the SPA's entry/login guards
// before IndexedDB hydration. No Domain attribute → cookie is scoped to the
// current environment host (aquilla.app, dev.aquilla.app, localhost).
const HINT_COOKIE = "aq_hint"

// [Pen test 2026-08-17] `Secure` prevents the cookie from ever being sent (or
// set) over a plaintext connection. Conditional on protocol rather than
// unconditional: an unconditional `Secure` attribute is silently dropped by
// the browser on http:// origins, which would break the hint on local dev
// (http://localhost) and any non-TLS preview host.
function secureAttr(): string {
  return typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : ""
}

function setAuthHint(): void {
  document.cookie = `${HINT_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax${secureAttr()}`
}

export function clearAuthHint(): void {
  document.cookie = `${HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secureAttr()}`
}

/**
 * Returns true when the auth-hint cookie (aq_hint=1) is present.
 *
 * The guard is also safe in non-browser test/build contexts where `document`
 * does not exist.
 */
export function hasAuthHintCookie(): boolean {
  if (typeof document === "undefined") return false
  return /(?:^|;\s*)aq_hint=1(?:;|$)/.test(document.cookie)
}
// --------------------------

function publishEnvelope(env: Envelope, notifyLocal = true): void {
  sessionRevision += 1
  if (env.active != null) {
    setAuthHint()
  } else {
    clearAuthHint()
  }
  if (notifyLocal) notify()
  pingOtherTabs()
}

// Every mutation is a read-modify-write of ONE envelope record. A same-tab
// promise chain keeps calls ordered, while the IndexedDB readwrite transaction
// below serializes that whole read-modify-write across tabs. The email backfill
// made the old race reachable in practice: a logout landing mid-backfill could
// be overwritten and make the removed account reappear. Reads stay unserialized.
let mutationQueue: Promise<unknown> = Promise.resolve()

/**
 * Runs `mutator` against a freshly-read envelope, with no other mutation
 * interleaving. Returning `false` skips the write (and its notify).
 */
function mutateEnvelope(
  mutator: (env: Envelope) => boolean | void,
  options: { notifyLocal?: boolean } = {},
): Promise<void> {
  const run = mutationQueue.then(async () => {
    const d = await db()
    // A single readwrite transaction is serialized by IndexedDB across every
    // connection/tab. Keeping the read and write in it prevents two tabs from
    // committing snapshots that silently overwrite each other's account edit.
    const tx = d.transaction(STORE, "readwrite")
    const existing = (await tx.store.get(ENVELOPE_KEY)) as Envelope | undefined
    const legacy = existing
      ? undefined
      : (await tx.store.get(LEGACY_KEY)) as FrontierSession | undefined
    const env = existing ?? (legacy
      ? { active: sessionKey(legacy), sessions: { [sessionKey(legacy)]: legacy } }
      : { active: null, sessions: {} })

    if (mutator(env) === false) {
      await tx.done
      return
    }
    await tx.store.put(env, ENVELOPE_KEY)
    if (legacy) await tx.store.delete(LEGACY_KEY)
    await tx.done
    publishEnvelope(env, options.notifyLocal !== false)
  })
  // A rejecting mutation must not poison later ones, but still reject for its
  // own caller.
  mutationQueue = run.catch(() => {})
  return run
}

export interface SessionSummary {
  key: string
  username: string
  /** Email decoded from JWT at login time, if available. */
  email?: string
  createdAt: string
  active: boolean
}

function summaries(env: Envelope): SessionSummary[] {
  return Object.entries(env.sessions).map(([key, s]) => ({
    key, username: s.username,
    email: s.email,
    createdAt: s.createdAt, active: env.active === key,
  }))
}

/** One IndexedDB read for the first auth decision and account menu state. */
export async function loadAccountsSnapshot(): Promise<{
  active: FrontierSession | null
  sessions: SessionSummary[]
  dataOwner?: string | null
}> {
  const env = await readEnvelope()
  return {
    active: env.active ? env.sessions[env.active] ?? null : null,
    sessions: summaries(env),
    dataOwner: env.dataOwner,
  }
}

/**
 * Durably records that cleanup/migration for `ownerKey` completed. The active
 * session is checked in the same serialized mutation so a superseded async
 * transition cannot publish its owner after another tab switches again.
 */
export async function publishDataOwner(ownerKey: string | null): Promise<boolean> {
  let published = false
  await mutateEnvelope((env) => {
    if (env.active !== ownerKey) return false
    published = true
    if (env.dataOwner === ownerKey) return false
    env.dataOwner = ownerKey
  }, { notifyLocal: false })
  return published
}

export async function listSessions(): Promise<SessionSummary[]> {
  const env = await readEnvelope()
  return summaries(env)
}

export interface StoredSession {
  key: string
  session: FrontierSession
}

/**
 * Credential-bearing snapshot for trusted background services. UI callers
 * should use listSessions(), which deliberately omits JWTs.
 */
export async function listStoredSessions(): Promise<StoredSession[]> {
  const env = await readEnvelope()
  return Object.entries(env.sessions).map(([key, session]) => ({ key, session }))
}

/** Exact owner/JWT fence used immediately before a background send. */
export async function isStoredSessionCurrent(ownerKey: string, jwt: string): Promise<boolean> {
  const env = await readEnvelope()
  return env.sessions[ownerKey]?.jwt === jwt
}

/**
 * Sessions whose email is not yet stored (legacy logins — JWT has no email
 * claim). Used to backfill via GET /auth/me per account JWT.
 */
export async function listSessionsNeedingEmail(): Promise<Array<{ key: string; jwt: string }>> {
  const env = await readEnvelope()
  return Object.entries(env.sessions)
    .filter(([, s]) => !s.email)
    .map(([key, s]) => ({ key, jwt: s.jwt }))
}

/** Every session's JWT, for a "sign out all accounts" fan-out that needs to
 *  revoke each token server-side before the local envelope is cleared. */
export async function listAllSessionJwts(): Promise<string[]> {
  const env = await readEnvelope()
  return Object.values(env.sessions).map((s) => s.jwt)
}

/** Batch-write emails onto existing sessions; no-op when nothing changes. */
export async function patchSessionEmails(updates: Record<string, string>): Promise<void> {
  if (Object.keys(updates).length === 0) return
  return mutateEnvelope((env) => {
    let changed = false
    for (const [key, email] of Object.entries(updates)) {
      const existing = env.sessions[key]
      if (!existing || !email || existing.email === email) continue
      env.sessions[key] = { ...existing, email }
      changed = true
    }
    return changed
  })
}

export async function addSession(s: FrontierSession): Promise<void> {
  return mutateEnvelope((env) => {
    const key = sessionKey(s)
    env.sessions[key] = s
    if (!env.active) env.active = key
  })
}

export async function activateSession(key: string): Promise<void> {
  return mutateEnvelope((env) => {
    if (!(key in env.sessions)) throw new Error(`Unknown session key: ${key}`)
    env.active = key
  })
}

export async function removeSession(key: string): Promise<void> {
  return mutateEnvelope((env) => {
    if (!(key in env.sessions)) return false
    delete env.sessions[key]
    if (env.active === key) {
      const remaining = Object.keys(env.sessions)
      env.active = remaining.length > 0 ? remaining[0] : null
    }
  })
}

export async function loadActiveSession(): Promise<FrontierSession | null> {
  const env = await readEnvelope()
  if (!env.active) return null
  return env.sessions[env.active] ?? null
}

// Backward-compat: existing login path uses saveSession. It adds-and-activates.
export async function saveSession(s: FrontierSession): Promise<void> {
  return mutateEnvelope((env) => {
    const key = sessionKey(s)
    env.sessions[key] = s
    env.active = key
  })
}

export async function loadSession(): Promise<FrontierSession | null> {
  return loadActiveSession()
}

export async function clearSession(): Promise<void> {
  return mutateEnvelope((env) => {
    env.active = null
    env.sessions = {}
  })
}

export async function _resetDbForTesting(): Promise<void> {
  const d = await db()
  await d.clear(STORE)
}
