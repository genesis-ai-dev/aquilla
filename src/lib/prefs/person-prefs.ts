/**
 * person-prefs — preferences that follow the person across their devices and
 * projects (AQU-2264; Sam, Oct 29, settings cleanup section 5d option B).
 *
 * Each preference is defined once (`definePersonPref`) with:
 *   - its key in the person's server record (`users.preferences`), and
 *   - the browser key it has always lived under on this device.
 *
 * WHO SEES WHAT
 *   Signed in  → the person's value. It is cached in this browser, under that
 *                person's own account scope, so the recorder opens instantly
 *                and works offline; the server is read in the background.
 *   Signed out → this device's own value, under the browser key it has always
 *                used, exactly as before. Signed-in edits never touch it.
 *
 * WRITES
 *   A signed-in edit lands in the cache at once and is queued (also in the
 *   cache, so a reload or going offline cannot lose it). The queue is sent
 *   shortly after the last edit, as ONE merge of just those keys
 *   (`PATCH /auth/me/preferences`), and retried with backoff — and as soon as
 *   the browser is back online — until the server has it. A key edited again
 *   while its save is in flight stays queued for the next send.
 *
 * READS
 *   On sign-in, on start, when the browser comes back online and when the tab
 *   comes back into view (at most every 30 s), the person's record is read.
 *   Each value the server holds replaces the cached one, unless this device
 *   still has an unsent edit for it (that edit is newer, and is on its way).
 *
 * FIRST DEVICE WINS
 *   A preference the person's record has none of yet takes THIS device's
 *   current value, sent as `setIfAbsent`: if another device got there first,
 *   the server keeps that one and this device adopts it from the reply. The
 *   first device to sync after this ships therefore gives the person their
 *   values, and every later device takes those.
 *
 * Values are JSON primitives (strings, booleans), so a read is a stable
 * snapshot for `useSyncExternalStore` without any memo of its own.
 */

import { useSyncExternalStore } from "react"
import {
  getClientLocalStorageOwner,
  localStorageKeyForOwner,
} from "@/lib/frontier/client-local-storage"
import {
  fetchPersonPreferences,
  patchPersonPreferences,
  type PersonPreferences,
} from "./person-prefs-api"
import { registerPersonPrefsReset } from "./person-prefs-reset"

export type PersonPrefValue = string | number | boolean

export interface PersonPrefSpec<T extends PersonPrefValue> {
  /** Key in the person's server record, e.g. "recorder.countdown". */
  serverKey: string
  /** The browser key this device has always kept it under. */
  deviceKey: string
  defaultValue: T
  /** A value from the server or the cache, or undefined when it isn't one. */
  parse: (value: unknown) => T | undefined
  /** How the device key stores a value; null removes the key. */
  toDevice: (value: T) => string | null
  /** The device key's stored text (null when absent) as a value. */
  fromDevice: (raw: string | null) => T
}

export interface PersonPref<T extends PersonPrefValue> {
  readonly spec: PersonPrefSpec<T>
  /** The value in force now (plain read for non-React code). */
  get: () => T
  set: (value: T) => void
}

/** Browser key (under each account's scope) of the cached record. */
export const PERSON_PREFS_RECORD_KEY = "aq.person-prefs.v1"
/** Quiet time after the last edit before the queue is sent. */
export const PERSON_PREFS_FLUSH_DELAY_MS = 400
/** A tab coming back into view re-reads the server at most this often. */
export const PERSON_PREFS_REFRESH_MIN_MS = 30_000
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

interface AccountRecord {
  /** The person's values: last read from the server, plus this device's edits. */
  values: Record<string, PersonPrefValue>
  /** Edits the server has not confirmed yet. */
  pending: Record<string, PersonPrefValue>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry of mixed value types
const registry = new Map<string, PersonPref<any>>()
const listeners = new Set<() => void>()
const deviceCache = new Map<string, PersonPrefValue>()
let recordCache: { owner: string; record: AccountRecord } | null = null

let session: { username: string; jwt: string } | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushing = false
let flushAgain = false
let retryIndex = 0
let lastReadAt = 0
let readGeneration = 0
let browserListenersInstalled = false
/** This device's values for keys the person's record lacked at the last read. */
let queuedOffer: Record<string, PersonPrefValue> = {}
/** Whose record was read last, and which keys it held. */
let lastRead: { owner: string; keys: Set<string> } | null = null

function notify(): void {
  for (const listener of listeners) {
    try { listener() } catch {
      // One subscriber's failure must not stop the rest from re-reading.
    }
  }
}

function isPrimitive(value: unknown): value is PersonPrefValue {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number"
}

/** The signed-in account whose values are in force, or null (signed out / not resolved yet). */
function activeAccount(): string | null {
  const owner = getClientLocalStorageOwner()
  return typeof owner === "string" ? owner : null
}

// ── This device's own values (signed out) ──────────────────────────────────

function readDevice<T extends PersonPrefValue>(spec: PersonPrefSpec<T>): T {
  const hit = deviceCache.get(spec.deviceKey)
  if (hit !== undefined) return hit as T
  let raw: string | null
  try {
    raw = typeof localStorage === "undefined" ? null : localStorage.getItem(spec.deviceKey)
  } catch {
    raw = null
  }
  const value = spec.fromDevice(raw)
  deviceCache.set(spec.deviceKey, value)
  return value
}

function writeDevice<T extends PersonPrefValue>(spec: PersonPrefSpec<T>, value: T): void {
  deviceCache.set(spec.deviceKey, value)
  if (typeof localStorage === "undefined") return
  try {
    const stored = spec.toDevice(value)
    if (stored == null) localStorage.removeItem(spec.deviceKey)
    else localStorage.setItem(spec.deviceKey, stored)
  } catch {
    // Quota or access denied: the in-memory value still reflects the edit.
  }
}

// ── The person's cached record (signed in) ────────────────────────────────

function primitives(value: unknown): Record<string, PersonPrefValue> {
  const out: Record<string, PersonPrefValue> = {}
  if (!value || typeof value !== "object" || Array.isArray(value)) return out
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isPrimitive(entry)) out[key] = entry
  }
  return out
}

function readRecord(owner: string): AccountRecord {
  if (recordCache?.owner === owner) return recordCache.record
  let record: AccountRecord = { values: {}, pending: {} }
  try {
    const raw = typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(localStorageKeyForOwner(owner, PERSON_PREFS_RECORD_KEY))
    if (raw) {
      const parsed = JSON.parse(raw) as { values?: unknown; pending?: unknown }
      record = { values: primitives(parsed.values), pending: primitives(parsed.pending) }
    }
  } catch {
    // Unreadable cache: start empty; the server read refills it.
  }
  recordCache = { owner, record }
  return record
}

function writeRecord(owner: string, record: AccountRecord): void {
  recordCache = { owner, record }
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(localStorageKeyForOwner(owner, PERSON_PREFS_RECORD_KEY), JSON.stringify(record))
  } catch {
    // Quota or access denied: the in-memory record still holds the edit and
    // its queue, so it is sent this session; only a reload could lose it.
  }
}

// ── Reading and writing one preference ───────────────────────────────────

function valueOf<T extends PersonPrefValue>(spec: PersonPrefSpec<T>): T {
  const owner = activeAccount()
  if (owner !== null) {
    const record = readRecord(owner)
    if (Object.hasOwn(record.values, spec.serverKey)) {
      return spec.parse(record.values[spec.serverKey]) ?? spec.defaultValue
    }
    // Not synced to this device yet: this device's value until the first read.
  }
  return readDevice(spec)
}

function setValue<T extends PersonPrefValue>(spec: PersonPrefSpec<T>, value: T): void {
  const owner = activeAccount()
  if (owner === null) {
    writeDevice(spec, value)
    notify()
    return
  }
  const record = readRecord(owner)
  writeRecord(owner, {
    values: { ...record.values, [spec.serverKey]: value },
    pending: { ...record.pending, [spec.serverKey]: value },
  })
  notify()
  scheduleFlush(PERSON_PREFS_FLUSH_DELAY_MS)
}

/** Define (and register) one preference that follows the person. */
export function definePersonPref<T extends PersonPrefValue>(spec: PersonPrefSpec<T>): PersonPref<T> {
  const existing = registry.get(spec.serverKey)
  if (existing) return existing as PersonPref<T>
  const pref: PersonPref<T> = {
    spec,
    get: () => valueOf(spec),
    set: (value: T) => setValue(spec, value),
  }
  registry.set(spec.serverKey, pref)
  // Registered after the person's record was read (its module loaded late),
  // and the record has none of it: offer this device's value now.
  const owner = activeAccount()
  if (lastRead && owner === lastRead.owner && session?.username === owner && !lastRead.keys.has(spec.serverKey)) {
    const record = readRecord(owner)
    if (!Object.hasOwn(record.pending, spec.serverKey)) {
      queuedOffer[spec.serverKey] = valueOf(spec)
      scheduleFlush(PERSON_PREFS_FLUSH_DELAY_MS)
    }
  }
  return pref
}

/** Every registered preference (for Preferences → Recording and the sync). */
export function listPersonPrefs(): PersonPref<PersonPrefValue>[] {
  return [...registry.values()]
}

export function subscribePersonPrefs(listener: () => void): () => void {
  installBrowserListeners()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Reactive read of one preference. */
export function usePersonPref<T extends PersonPrefValue>(pref: PersonPref<T>): T {
  return useSyncExternalStore(subscribePersonPrefs, pref.get, () => pref.spec.defaultValue)
}

// ── Sync with the server ─────────────────────────────────────────────────

/**
 * Take in the server's record for `owner`: each value it holds replaces the
 * cached one, unless this device has an unsent edit for it. Every key is
 * kept, not only the registered ones, so a preference whose module loads
 * later (a lazy chunk) still finds the person's value.
 */
function adopt(owner: string, server: PersonPreferences): void {
  lastRead = { owner, keys: new Set(Object.keys(server)) }
  const record = readRecord(owner)
  const values = { ...record.values }
  let changed = false
  for (const [key, incoming] of Object.entries(server)) {
    if (Object.hasOwn(record.pending, key) || !isPrimitive(incoming)) continue
    if (values[key] !== incoming) {
      values[key] = incoming
      changed = true
    }
  }
  if (changed) {
    writeRecord(owner, { ...record, values })
    notify()
  }
}

/** This device's values for the keys the person's record lacks. */
function offerForMissing(owner: string, server: PersonPreferences): Record<string, PersonPrefValue> {
  const record = readRecord(owner)
  const offer: Record<string, PersonPrefValue> = {}
  for (const [key, pref] of registry) {
    if (Object.hasOwn(server, key) || Object.hasOwn(record.pending, key)) continue
    offer[key] = Object.hasOwn(record.values, key)
      ? (pref.spec.parse(record.values[key]) ?? pref.spec.defaultValue)
      : readDevice(pref.spec)
  }
  return offer
}

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false
}

function clearFlushTimer(): void {
  if (flushTimer != null) clearTimeout(flushTimer)
  flushTimer = null
}

function scheduleFlush(delayMs: number): void {
  clearFlushTimer()
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPersonPrefs()
  }, delayMs)
}

function scheduleRetry(): void {
  const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)]
  retryIndex += 1
  scheduleFlush(delay)
}

function statusOf(error: unknown): unknown {
  return (error as { status?: unknown } | null)?.status
}

/**
 * Send this device's queued edits, with its values for keys the person's
 * record lacks (`setIfAbsent`). Resolves when done; a failure is retried on
 * its own (with backoff, and when the browser comes back online).
 */
export async function flushPersonPrefs(): Promise<void> {
  const current = session
  if (!current || activeAccount() !== current.username) return
  if (flushing) {
    flushAgain = true
    return
  }
  const owner = current.username
  const sent = { ...readRecord(owner).pending }
  const offered: Record<string, PersonPrefValue> = {}
  for (const [key, value] of Object.entries(queuedOffer)) {
    if (!Object.hasOwn(sent, key)) offered[key] = value
  }
  const hasSet = Object.keys(sent).length > 0
  const hasOffer = Object.keys(offered).length > 0
  if (!hasSet && !hasOffer) return
  if (!online()) return // the "online" listener sends it
  clearFlushTimer()
  flushing = true
  try {
    const stored = await patchPersonPreferences(current.jwt, {
      ...(hasSet ? { set: sent } : {}),
      ...(hasOffer ? { setIfAbsent: offered } : {}),
    })
    retryIndex = 0
    for (const key of Object.keys(offered)) delete queuedOffer[key]
    if (activeAccount() !== owner) return
    // Confirmed: drop each queued edit the server now has — unless it was
    // edited again while this save was in flight.
    const record = readRecord(owner)
    const pending = { ...record.pending }
    for (const [key, value] of Object.entries(sent)) {
      if (pending[key] === value) delete pending[key]
    }
    writeRecord(owner, { ...record, pending })
    adopt(owner, stored)
  } catch (error) {
    const status = statusOf(error)
    if ((status === 400 || status === 413) && activeAccount() === owner) {
      // The server will never take these as sent: keep the values on this
      // device rather than retrying forever.
      const record = readRecord(owner)
      const pending = { ...record.pending }
      for (const key of Object.keys(sent)) delete pending[key]
      writeRecord(owner, { ...record, pending })
      for (const key of Object.keys(offered)) delete queuedOffer[key]
    } else if (status !== 401 && status !== 403) {
      // Offline, timed out, or the server had a moment. (A refused token
      // waits for the renewed session instead, which sends at once.)
      scheduleRetry()
    }
  } finally {
    flushing = false
    if (flushAgain) {
      flushAgain = false
      scheduleFlush(0)
    }
  }
}

/**
 * Read the person's record and take it in, then send this device's queued
 * edits together with its values for anything the record lacks.
 */
export async function refreshPersonPrefs(): Promise<void> {
  const current = session
  if (!current || activeAccount() !== current.username || !online()) return
  const generation = ++readGeneration
  lastReadAt = Date.now()
  let server: PersonPreferences
  try {
    server = await fetchPersonPreferences(current.jwt)
  } catch {
    // Offline or refused: the cache stands; the next trigger reads again.
    lastReadAt = 0
    return
  }
  if (generation !== readGeneration || session !== current || activeAccount() !== current.username) return
  adopt(current.username, server)
  queuedOffer = offerForMissing(current.username, server)
  await flushPersonPrefs()
}

/**
 * The signed-in session the sync uses, or null when signed out. A new person
 * (or a first session) reads their record at once and sends anything queued.
 */
export function setPersonPrefsSession(next: { username: string; jwt: string } | null): void {
  const previous = session
  if (previous?.username === next?.username && previous?.jwt === next?.jwt) return
  session = next
  installBrowserListeners()
  if (previous?.username !== next?.username) {
    // Someone else's values (or this device's own) are in force now.
    clearFlushTimer()
    queuedOffer = {}
    lastRead = null
    retryIndex = 0
    recordCache = null
    notify()
    if (next) void refreshPersonPrefs()
    return
  }
  if (next && Object.keys(readRecord(next.username).pending).length > 0) {
    // Same person, renewed token: anything refused on the old one goes now.
    scheduleFlush(0)
  }
}

function installBrowserListeners(): void {
  if (browserListenersInstalled || typeof window === "undefined") return
  browserListenersInstalled = true
  window.addEventListener("online", () => {
    retryIndex = 0
    void refreshPersonPrefs()
  })
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - lastReadAt < PERSON_PREFS_REFRESH_MIN_MS) return
      void refreshPersonPrefs()
    })
  }
  // Another tab of this browser changed a value: re-read it.
  window.addEventListener("storage", (event) => {
    if (event.key == null) {
      recordCache = null
      deviceCache.clear()
      notify()
      return
    }
    if (event.key.endsWith(`:${PERSON_PREFS_RECORD_KEY}`)) {
      recordCache = null
      notify()
      return
    }
    for (const pref of registry.values()) {
      if (pref.spec.deviceKey === event.key) {
        deviceCache.delete(event.key)
        notify()
        return
      }
    }
  })
}

// ── Test helpers ────────────────────────────────────────────────────────

/** Forget cached reads so a fresh localStorage is read (tests). */
export function resetPersonPrefCachesForTests(): void {
  deviceCache.clear()
  recordCache = null
}

/** Forget the session, timers and queued sends as well (tests). */
export function resetPersonPrefsSyncForTests(): void {
  resetPersonPrefCachesForTests()
  clearFlushTimer()
  session = null
  queuedOffer = {}
  lastRead = null
  flushing = false
  flushAgain = false
  retryIndex = 0
  lastReadAt = 0
  readGeneration += 1
}

// src/test-setup.ts resets this module between tests through the seam, so it
// does not import person-prefs (and frontier/auth, orgs, elevation under it)
// before a test file's vi.mock() calls run. See person-prefs-reset.ts.
registerPersonPrefsReset(resetPersonPrefsSyncForTests)
