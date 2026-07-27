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
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

export async function readPersistedSession(
  username: SeedUser["username"],
  frontierBaseOverride?: string,
  authRoot?: string,
): Promise<PersistedSession> {
  const file = authStateFile(username, frontierBaseOverride, authRoot)
  return JSON.parse(await fs.readFile(file, "utf8")) as PersistedSession
}
