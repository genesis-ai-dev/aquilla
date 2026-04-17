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

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function sessionKey(s: FrontierSession): string {
  return `${s.gitlabUrl}::${s.username}`
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

async function writeEnvelope(env: Envelope): Promise<void> {
  const d = await db()
  await d.put(STORE, env, ENVELOPE_KEY)
  notify()
}

export interface SessionSummary {
  key: string
  username: string
  gitlabUrl: string
  createdAt: string
  active: boolean
}

export async function listSessions(): Promise<SessionSummary[]> {
  const env = await readEnvelope()
  return Object.entries(env.sessions).map(([key, s]) => ({
    key, username: s.username, gitlabUrl: s.gitlabUrl,
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
  await writeEnvelope(env)
}

export async function loadActiveSession(): Promise<FrontierSession | null> {
  const env = await readEnvelope()
  if (!env.active) return null
  return env.sessions[env.active] ?? null
}

// Backward-compat: existing login path uses saveSession. It adds-and-activates.
export async function saveSession(s: FrontierSession): Promise<void> {
  const env = await readEnvelope()
  const key = sessionKey(s)
  env.sessions[key] = s
  env.active = key
  await writeEnvelope(env)
}

export async function loadSession(): Promise<FrontierSession | null> {
  return loadActiveSession()
}

export async function clearSession(): Promise<void> {
  const env = await readEnvelope()
  env.active = null
  env.sessions = {}
  await writeEnvelope(env)
}

export async function _resetDbForTesting(): Promise<void> {
  const d = await db()
  await d.clear(STORE)
}
