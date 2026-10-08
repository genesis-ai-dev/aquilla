import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { SeedUser } from "./seed"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_AUTH_ROOT = path.resolve(__dirname, "../.auth")
const DEFAULT_FRONTIER_BASE = "http://127.0.0.1:8787"
let temporarySequence = 0

export interface PersistedSession {
  jwt: string
  username: string
  email?: string
  createdAt: string
}

function frontierBase(frontierBaseOverride?: string): string {
  return frontierBaseOverride
    ?? process.env.VITE_FRONTIER_BASE
    ?? DEFAULT_FRONTIER_BASE
}

export function authStateFile(
  username: SeedUser["username"],
  frontierBaseOverride?: string,
  authRoot = DEFAULT_AUTH_ROOT,
): string {
  const origin = new URL(frontierBase(frontierBaseOverride)).origin
  const namespace = origin.replace(/[^a-zA-Z0-9.-]+/g, "_")
  return path.join(authRoot, namespace, `${username}.json`)
}

export async function writePersistedSession(
  session: PersistedSession,
  frontierBaseOverride?: string,
  authRoot?: string,
): Promise<void> {
  const file = authStateFile(session.username as SeedUser["username"], frontierBaseOverride, authRoot)
  const directory = path.dirname(file)
  await fs.mkdir(directory, { recursive: true })

  // Each sharded stack writes its own namespace. Publishing through a
  // same-directory rename additionally guarantees readers never observe the
  // truncate/write window of fs.writeFile on the final sidecar path.
  const temporary = path.join(
    directory,
    `.${session.username}.${process.pid}.${temporarySequence++}.tmp`,
  )
  try {
    await fs.writeFile(temporary, JSON.stringify(session, null, 2), { mode: 0o600 })
    await publishAtomically(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

/**
 * Windows refuses a replacing rename with EPERM/EACCES while any handle is still
 * open on the destination, which concurrent publishers and readers routinely hit.
 * A fixed 10ms pause skips the gaps between those reads and the old 50-try cap
 * gives up in about half a second, which is not long enough while the pre-push
 * hook is busy. Keep retrying, yielding so the readers can close the file.
 * The rename either replaces the file whole or has not happened, so a reader
 * never sees a partial write.
 */
async function publishAtomically(temporary: string, file: string): Promise<void> {
  const deadline = Date.now() + 4_000
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temporary, file)
      return
    } catch (error) {
      if (!retryableRename(error) || Date.now() >= deadline) throw error
      const delay = attempt < 80 ? 0 : Math.min(20, Math.floor((attempt - 80) / 4) + 1)
      await new Promise((resolve) => {
        if (delay === 0) setImmediate(resolve)
        else setTimeout(resolve, delay)
      })
    }
  }
}

function retryableRename(error: unknown): boolean {
  const code = errnoOf(error)
  if (code === "EPERM" || code === "EACCES" || code === "EBUSY") return true
  return error instanceof Error && /^(EPERM|EACCES|EBUSY):/.test(error.message)
}

function errnoOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

export async function readPersistedSession(
  username: SeedUser["username"],
  frontierBaseOverride?: string,
  authRoot?: string,
): Promise<PersistedSession> {
  const file = authStateFile(username, frontierBaseOverride, authRoot)
  return JSON.parse(await fs.readFile(file, "utf8")) as PersistedSession
}
