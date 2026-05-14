import { type Page, request as pwRequest } from "@playwright/test"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { seedUser, type SeedUser } from "./seed"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, "../.auth")

if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true })

const AUTH_BASE = process.env.VITE_AUTH_BASE ?? "http://127.0.0.1:8787"

interface AuthResponse {
  access_token: string
  token_type: string
  // GitLab fields are returned as null/empty strings by frontier-server —
  // codex-web dropped its GitLab integration (#66), but the legacy field
  // names are preserved in the response so existing helpers keep parsing.
  gitlab_token?: string
  gitlab_url?: string
}

export interface PersistedSession {
  jwt: string
  gitlabToken: string
  gitlabUrl: string
  username: string
  createdAt: string
}

/** Logs the seed user in via API and writes a JSON sidecar at
 * `e2e/.auth/<username>.json` containing the FrontierSession. Returns
 * the session for immediate use. Always re-mints (no cache) so the
 * stored JWT matches the just-reset DB. */
export async function ensureAuthState(username: SeedUser["username"]): Promise<PersistedSession> {
  const file = path.join(AUTH_DIR, `${username}.json`)
  const u = seedUser(username)

  const ctx = await pwRequest.newContext()
  try {
    const r = await ctx.post(`${AUTH_BASE}/api/v1/auth/token`, {
      data: { username: u.username, password: u.password },
    })
    if (!r.ok()) {
      throw new Error(`login ${username} failed: HTTP ${r.status()} — ${await r.text()}`)
    }
    const auth = (await r.json()) as AuthResponse
    const session: PersistedSession = {
      jwt: auth.access_token,
      gitlabToken: auth.gitlab_token ?? "",
      gitlabUrl: (auth.gitlab_url ?? "").replace(/\/+$/, ""),
      username: u.username,
      createdAt: new Date().toISOString(),
    }
    await fs.writeFile(file, JSON.stringify(session, null, 2))
    return session
  } finally {
    await ctx.dispose()
  }
}

export async function readPersistedSession(username: SeedUser["username"]): Promise<PersistedSession> {
  const file = path.join(AUTH_DIR, `${username}.json`)
  return JSON.parse(await fs.readFile(file, "utf-8")) as PersistedSession
}

/** Inject the FrontierSession into the page's IndexedDB so the app boots
 * already-authenticated. Mirrors the envelope layout in
 * src/lib/frontier/session-store.ts.
 *
 * Call AFTER `await page.goto("/")` so the IDB origin is correct.
 * The function reloads the page so the app picks up the seeded session. */
export async function injectSession(page: Page, session: PersistedSession): Promise<void> {
  await page.evaluate(async (s) => {
    const DB = "frontier"
    const STORE = "session"
    const ENVELOPE_KEY = "envelope"
    const sessionKey = `${s.gitlabUrl}::${s.username}`

    // Open / create the IDB.
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) {
        open.result.createObjectStore(STORE)
      }
    }
    await new Promise<void>((resolve, reject) => {
      open.onsuccess = () => resolve()
      open.onerror = () => reject(open.error)
    })
    const db = open.result

    // Write the envelope with this session as both stored and active.
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    store.put(
      {
        active: sessionKey,
        sessions: { [sessionKey]: s },
      },
      ENVELOPE_KEY,
    )
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()

    // Mark onboarding complete so the app routes straight to dashboard.
    localStorage.setItem("codex:onboardingComplete", "true")
  }, session)

  // Reload so the app picks up the seeded session.
  await page.reload()
  await page.waitForLoadState("networkidle")
}

/** Convenience: load JSON from disk and inject into a page in one call. */
export async function injectSessionFromDisk(
  page: Page,
  username: SeedUser["username"],
): Promise<PersistedSession> {
  const session = await readPersistedSession(username)
  await injectSession(page, session)
  return session
}
