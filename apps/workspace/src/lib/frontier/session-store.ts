import { openDB } from "idb"
import { clearJwt, getJwt, setJwt } from "@aquilla/auth-client"
import type { FrontierSession } from "./types"

const DB = "frontier"
const STORE = "session"
const ENVELOPE_KEY = "envelope"
const SINGLE_SESSION_KEY = "current"

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

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function sessionKey(s: FrontierSession): string {
  return s.username
}

async function readEnvelope(): Promise<Envelope> {
  const d = await db()
  const existing = (await d.get(STORE, ENVELOPE_KEY)) as Envelope | undefined
  if (existing) return await reconcileEnvelopeWithCookie(existing)
  const singleSession = (await d.get(STORE, SINGLE_SESSION_KEY)) as FrontierSession | undefined
  if (singleSession) {
    const key = sessionKey(singleSession)
    const envelope: Envelope = { active: key, sessions: { [key]: singleSession } }
    await d.put(STORE, envelope, ENVELOPE_KEY)
    await d.delete(STORE, SINGLE_SESSION_KEY)
    return await reconcileEnvelopeWithCookie(envelope)
  }
  return await reconcileEnvelopeWithCookie({ active: null, sessions: {} })
}

async function writeEnvelope(env: Envelope): Promise<void> {
  const d = await db()
  await d.put(STORE, env, ENVELOPE_KEY)
  notify()
}

export interface SessionSummary {
  key: string
  username: string
  createdAt: string
  active: boolean
}

export async function listSessions(): Promise<SessionSummary[]> {
  const env = await readEnvelope()
  return Object.entries(env.sessions).map(([key, s]) => ({
    key, username: s.username,
    createdAt: s.createdAt, active: env.active === key,
  }))
}

export async function addSession(s: FrontierSession): Promise<void> {
  const env = await readEnvelope()
  const key = sessionKey(s)
  env.sessions[key] = s
  if (!env.active) env.active = key
  await writeEnvelope(env)
}

export async function activateSession(key: string): Promise<void> {
  const env = await readEnvelope()
  if (!(key in env.sessions)) throw new Error(`Unknown session key: ${key}`)
  env.active = key
  writeJwtCookie(env.sessions[key])
  await writeEnvelope(env)
}

export async function removeSession(key: string): Promise<void> {
  const env = await readEnvelope()
  if (!(key in env.sessions)) return
  delete env.sessions[key]
  if (env.active === key) {
    const remaining = Object.keys(env.sessions)
    env.active = remaining.length > 0 ? remaining[0] : null
  }
  const nextActive = env.active ? env.sessions[env.active] : null
  if (nextActive) writeJwtCookie(nextActive)
  else clearJwt()
  await writeEnvelope(env)
}

export async function loadActiveSession(): Promise<FrontierSession | null> {
  const env = await readEnvelope()
  if (!env.active) return null
  return env.sessions[env.active] ?? null
}

// Existing workspace login/register calls saveSession. It adds and activates.
export async function saveSession(s: FrontierSession): Promise<void> {
  const env = await readEnvelope()
  const key = sessionKey(s)
  env.sessions[key] = s
  env.active = key
  writeJwtCookie(s)
  await writeEnvelope(env)
}

export async function loadSession(): Promise<FrontierSession | null> {
  return loadActiveSession()
}

export async function clearSession(): Promise<void> {
  const env = await readEnvelope()
  env.active = null
  env.sessions = {}
  clearJwt()
  await writeEnvelope(env)
}

export async function _resetDbForTesting(): Promise<void> {
  const d = await db()
  await d.clear(STORE)
}

async function reconcileEnvelopeWithCookie(env: Envelope): Promise<Envelope> {
  const cookieSession = sessionFromCookie()
  if (!cookieSession) return env

  const active = env.active ? env.sessions[env.active] : null
  if (active?.jwt === cookieSession.jwt) return env

  const key = sessionKey(cookieSession)
  const next: Envelope = {
    active: key,
    sessions: {
      ...env.sessions,
      [key]: cookieSession,
    },
  }
  await writeEnvelope(next)
  return next
}

function sessionFromCookie(): FrontierSession | null {
  const jwt = getJwt()
  if (!jwt) return null

  const payload = decodeJwtPayload(jwt)
  const username = payloadString(payload, "sub") ?? payloadString(payload, "username")
  if (!username) return null

  const iat = payloadNumber(payload, "iat")
  return {
    jwt,
    username,
    createdAt: new Date((iat ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  }
}

function writeJwtCookie(session: FrontierSession): void {
  try {
    setJwt(session.jwt)
  } catch {
    // Session storage is exercised in non-browser tests too; cookie sync is
    // best-effort outside the browser.
  }
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const payload = jwt.split(".")[1]
  if (!payload) return null
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
    const parsed = JSON.parse(atob(padded)) as unknown
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function payloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key]
  return typeof value === "string" && value ? value : null
}

function payloadNumber(payload: Record<string, unknown> | null, key: string): number | null {
  const value = payload?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
