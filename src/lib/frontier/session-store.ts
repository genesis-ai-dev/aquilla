import { openDB } from "idb"
import type { FrontierSession } from "./types"

const DB = "frontier"
const STORE = "session"
const ENVELOPE_KEY = "envelope"
const LEGACY_KEY = "current"

interface Envelope {
  active: string | null
  sessions: Record<string, FrontierSession>
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

function pingOtherTabs(): void {
  try {
    localStorage.setItem(PING_KEY, `${Date.now()}:${crypto.randomUUID()}`)
  } catch {
    // localStorage unavailable (quota, private mode) — cross-tab sync degrades
    // to the pre-fix behavior (reload to reconcile); this tab is unaffected.
  }
}

let crossTabInstalled = false
function ensureCrossTabListener(): void {
  if (crossTabInstalled || typeof window === "undefined") return
  crossTabInstalled = true
  window.addEventListener("storage", (e) => {
    if (e.key === PING_KEY) notify()
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
// A non-credential, host-only 1-bit cookie that the aquilla-web Worker reads
// at the edge to decide whether to serve the SPA or the homepage without
// waiting for IDB. No Domain attribute → cookie is scoped to whichever host
// (aquilla.app, dev.aquilla.app, localhost) wrote it, keeping envs isolated.
const HINT_COOKIE = "aq_hint"

function setAuthHint(): void {
  document.cookie = `${HINT_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function clearAuthHint(): void {
  document.cookie = `${HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

/**
 * Returns true when the auth-hint cookie (aq_hint=1) is present.
 *
 * Marketing pages call this during render and are also rendered in Node by the
 * build-time prerender (scripts/prerender-marketing.ts), where there is no
 * `document` — the prerendered fallback is always the signed-out variant.
 */
export function hasAuthHintCookie(): boolean {
  if (typeof document === "undefined") return false
  return /(?:^|;\s*)aq_hint=1(?:;|$)/.test(document.cookie)
}
// --------------------------

async function writeEnvelope(env: Envelope): Promise<void> {
  const d = await db()
  await d.put(STORE, env, ENVELOPE_KEY)
  if (env.active != null) {
    setAuthHint()
  } else {
    clearAuthHint()
  }
  notify()
  pingOtherTabs()
}

// Every mutation is a read-modify-write of ONE envelope record, and the read
// and the write are separate awaits. Two overlapping mutations therefore
// interleave, and the slower one writes back a snapshot taken before the
// faster one landed — silently undoing it. The email backfill made this
// reachable in practice: it runs while the account menu is open, so a logout
// landing mid-backfill got its removal overwritten and the account came back.
// Serialize mutations through one chain. Reads stay unserialized.
let mutationQueue: Promise<unknown> = Promise.resolve()

/**
 * Runs `mutator` against a freshly-read envelope, with no other mutation
 * interleaving. Returning `false` skips the write (and its notify).
 */
function mutateEnvelope(mutator: (env: Envelope) => boolean | void): Promise<void> {
  const run = mutationQueue.then(async () => {
    const env = await readEnvelope()
    if (mutator(env) === false) return
    await writeEnvelope(env)
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

export async function listSessions(): Promise<SessionSummary[]> {
  const env = await readEnvelope()
  return Object.entries(env.sessions).map(([key, s]) => ({
    key, username: s.username,
    email: s.email,
    createdAt: s.createdAt, active: env.active === key,
  }))
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
