// Machine-wide lock for one e2e shard slot.
//
// Two worktrees (or a pre-push overlapping another run) otherwise reach
// freePort() and DROP DATABASE on the same slot at once. The lock is a
// directory, aquilla-e2e-slot-<K>.lock, published by renaming a non-empty
// staging directory onto that name. mkdir of the final path is not exclusive
// here: on macOS rename() replaces an empty directory, so a waiter could
// swap out a lock that had been mkdir'd but not yet written.
//
// E2E_LOCK=off skips the lock. E2E_LOCK_WAIT_SECONDS bounds the wait
// (default 30 minutes). Different slot numbers never share a directory.

import { randomBytes } from "node:crypto"
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

export const DEFAULT_E2E_LOCK_WAIT_SECONDS = 30 * 60
export const E2E_LOCK_POLL_MS = 2_000
export const E2E_LOCK_LOG_EVERY_MS = 30_000
export const E2E_LOCK_OWNER_FILE = "owner.json"

export interface E2eLockRecord {
  pid: number
  cwd: string
  startedAt: string
  command: string
  // Distinguishes our directory from a successor's after a stale takeover
  // replaced it, so a late release does not delete the new owner's lock.
  token: string
}

export interface E2eSlotLock {
  slot: number
  path: string
  record: E2eLockRecord
  release: () => void
}

export interface AcquireE2eSlotLockOptions {
  slot: number
  /** Directory that contains the lock. Tests inject a temp dir. */
  root?: string
  cwd?: string
  command?: string
  pid?: number
  startedAt?: string
  /** Overrides E2E_LOCK_WAIT_SECONDS. */
  waitSeconds?: number
  pollMs?: number
  logEveryMs?: number
  /** When set, read E2E_LOCK / E2E_LOCK_WAIT_SECONDS from here instead of process.env. */
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  isAlive?: (pid: number) => boolean
  now?: () => number
}

export function e2eSlotLockPath(slot: number, root: string = os.tmpdir()): string {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`[e2e-up] e2e slot must be a non-negative integer (got ${String(slot)})`)
  }
  return path.join(root, `aquilla-e2e-slot-${slot}.lock`)
}

/** process.kill(pid, 0) throws ESRCH when the pid is gone. EPERM means it exists. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errno(error) !== "ESRCH"
  }
}

export async function acquireE2eSlotLock(options: AcquireE2eSlotLockOptions): Promise<E2eSlotLock> {
  const env = options.env ?? process.env
  const record = createRecord(options)
  if (env.E2E_LOCK === "off") {
    return { slot: options.slot, path: "", record, release() {} }
  }

  const lockPath = e2eSlotLockPath(options.slot, options.root ?? os.tmpdir())
  const pollMs = options.pollMs ?? E2E_LOCK_POLL_MS
  const logEveryMs = options.logEveryMs ?? E2E_LOCK_LOG_EVERY_MS
  const waitSeconds = resolveWaitSeconds(env, options.waitSeconds)
  const log = options.log ?? defaultLog
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const alive = options.isAlive ?? isPidAlive
  const now = options.now ?? Date.now
  const deadline = now() + waitSeconds * 1000
  let logged = false
  let lastLogAt = 0

  for (;;) {
    if (tryCreate(lockPath, record)) return adopt(options.slot, lockPath, record)

    const holder = readRecord(lockPath)
    if (!holder || !alive(holder.pid)) {
      if (tryTakeover(lockPath, record, alive) && readRecord(lockPath)?.token === record.token) {
        return adopt(options.slot, lockPath, record)
      }
      if (now() >= deadline) fail(lockPath, readRecord(lockPath) ?? holder, waitSeconds)
      await sleep(pollMs)
      continue
    }

    const t = now()
    if (!logged || t - lastLogAt >= logEveryMs) {
      log(waitLine(holder))
      logged = true
      lastLogAt = t
    }
    if (t >= deadline) fail(lockPath, holder, waitSeconds)
    const remaining = deadline - t
    await sleep(Math.min(pollMs, remaining))
  }
}

function createRecord(options: AcquireE2eSlotLockOptions): E2eLockRecord {
  return {
    pid: options.pid ?? process.pid,
    cwd: options.cwd ?? process.cwd(),
    startedAt: options.startedAt ?? new Date().toISOString(),
    command: options.command ?? process.argv.join(" "),
    token: randomBytes(16).toString("hex"),
  }
}

function resolveWaitSeconds(env: NodeJS.ProcessEnv, override: number | undefined): number {
  if (override !== undefined) return override
  const raw = env.E2E_LOCK_WAIT_SECONDS
  if (raw == null || raw === "") return DEFAULT_E2E_LOCK_WAIT_SECONDS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`[e2e-up] E2E_LOCK_WAIT_SECONDS must be a non-negative number (got ${raw})`)
  }
  return parsed
}

function waitLine(holder: E2eLockRecord): string {
  return `[e2e-up] waiting for the e2e run in ${holder.cwd} (pid ${holder.pid}, started ${holder.startedAt}) to finish…`
}

function fail(lockPath: string, holder: E2eLockRecord | null, waitSeconds: number): never {
  const who = holder
    ? `The run in ${holder.cwd} (pid ${holder.pid}, started ${holder.startedAt}, command: ${holder.command}) still holds it.`
    : "The lock is present but has no readable owner."
  const inspect = holder
    ? `Inspect it with: ps -p ${holder.pid} -o pid,etime,command`
    : `Inspect it with: ls -la ${JSON.stringify(lockPath)}`
  throw new Error(
    [
      `[e2e-up] gave up after ${waitSeconds}s waiting for the e2e lock at ${lockPath}.`,
      who,
      inspect,
      `Clear a stale lock with: rm -rf ${JSON.stringify(lockPath)}`,
      "Skip the lock in an emergency with: E2E_LOCK=off",
    ].join("\n"),
  )
}

function defaultLog(line: string): void {
  // A pipe (pre-push, a captured agent log) block-buffers console.log, so a
  // multi-minute wait would look hung until the process exited.
  writeSync(1, `${line}\n`)
}

function adopt(slot: number, lockPath: string, record: E2eLockRecord): E2eSlotLock {
  let released = false
  return {
    slot,
    path: lockPath,
    record,
    release() {
      if (released) return
      released = true
      releaseOnDisk(lockPath, record.token)
    },
  }
}

function tryCreate(lockPath: string, record: E2eLockRecord): boolean {
  const staging = `${lockPath}.${record.pid}.${record.token}.staging`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging)
  try {
    writeFileSync(path.join(staging, E2E_LOCK_OWNER_FILE), JSON.stringify(record))
    try {
      renameDir(staging, lockPath)
    } catch (error) {
      if (errno(error) === "ENOENT" || destinationTaken(error, lockPath)) return false
      // Still locked after the retries below. The acquire loop will try again;
      // crashing here drops the waiter on the floor (the race test's round 2).
      if (errno(error) === "EPERM" && process.platform === "win32") return false
      throw error
    }
    return readRecord(lockPath)?.token === record.token
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function tryTakeover(
  lockPath: string,
  record: E2eLockRecord,
  alive: (pid: number) => boolean,
): boolean {
  if (!exists(lockPath)) return false
  const snapshot = readRaw(lockPath)
  const parsed = snapshot === null ? null : parseRecord(snapshot)
  if (parsed && alive(parsed.pid)) return false

  const claim = `${lockPath}.${record.pid}.${record.token}.claim`
  rmSync(claim, { recursive: true, force: true })
  try {
    renameDir(lockPath, claim)
  } catch (error) {
    if (errno(error) === "ENOENT") return false
    if (errno(error) === "EPERM" && process.platform === "win32") return false
    throw error
  }

  try {
    const claimed = readRaw(claim)
    const claimedRecord = claimed === null ? null : parseRecord(claimed)
    // The directory we moved aside must still be the stale one we observed.
    // Otherwise a newer lock landed between the read and the rename, and
    // deleting it would steal a live run. Only one rename can win.
    const stoleNewer = snapshot !== null && claimed !== snapshot
    const stoleLive = claimedRecord !== null && alive(claimedRecord.pid)
    if (stoleNewer || stoleLive) {
      restore(claim, lockPath)
      return false
    }
    rmSync(claim, { recursive: true, force: true })
  } catch (error) {
    restore(claim, lockPath)
    throw error
  }
  return tryCreate(lockPath, record)
}

function releaseOnDisk(lockPath: string, token: string): void {
  const retiring = `${lockPath}.${token}.release`
  rmSync(retiring, { recursive: true, force: true })
  try {
    renameDir(lockPath, retiring)
  } catch (error) {
    if (errno(error) === "ENOENT") return
    throw error
  }
  const owned = readRecord(retiring)
  if (owned?.token === token) {
    rmSync(retiring, { recursive: true, force: true })
    return
  }
  restore(retiring, lockPath)
}

function restore(claim: string, lockPath: string): void {
  try {
    renameDir(claim, lockPath)
  } catch (error) {
    if (destinationTaken(error, lockPath)) {
      rmSync(claim, { recursive: true, force: true })
      return
    }
    if (errno(error) === "ENOENT") return
    throw error
  }
}

/** Windows directory rename is not the POSIX replace. Onto an existing
 *  directory it returns EPERM (macOS/Linux: EEXIST or ENOTEMPTY). The same
 *  code comes back when the destination was just removed, or when the
 *  staging directory is still locked for a moment after its owner file was
 *  written. Retry those; a destination that is actually there is a lost race. */
function renameDir(source: string, destination: string): void {
  const attempts = process.platform === "win32" ? 10 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      const blocked = errno(error) === "EPERM" && process.platform === "win32" && !exists(destination)
      if (!blocked || attempt === attempts - 1) throw error
      sleepSync(15 * (attempt + 1))
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function destinationTaken(error: unknown, destination: string): boolean {
  const code = errno(error)
  if (code === "ENOTEMPTY" || code === "EEXIST") return true
  return code === "EPERM" && process.platform === "win32" && exists(destination)
}

function readRecord(lockPath: string): E2eLockRecord | null {
  const raw = readRaw(lockPath)
  if (raw === null) return null
  return parseRecord(raw)
}

function readRaw(lockPath: string): string | null {
  try {
    return readFileSync(path.join(lockPath, E2E_LOCK_OWNER_FILE), "utf8")
  } catch (error) {
    if (errno(error) === "ENOENT") return null
    throw error
  }
}

function parseRecord(raw: string): E2eLockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<E2eLockRecord>
    if (!value || typeof value !== "object") return null
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) return null
    if (typeof value.token !== "string" || value.token.length === 0) return null
    return {
      pid: value.pid,
      cwd: typeof value.cwd === "string" ? value.cwd : "",
      startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
      command: typeof value.command === "string" ? value.command : "",
      token: value.token,
    }
  } catch {
    return null
  }
}

function exists(target: string): boolean {
  try {
    statSync(target)
    return true
  } catch (error) {
    if (errno(error) === "ENOENT") return false
    throw error
  }
}

function errno(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}
