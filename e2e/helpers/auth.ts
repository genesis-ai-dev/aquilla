import { type Page, request as pwRequest } from "@playwright/test"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { seedUser, type SeedUser } from "./seed"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, "../.auth")

if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true })

const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

interface AuthResponse {
  access_token: string
  token_type: string
}

// Mirrors src/lib/frontier/types.ts FrontierSession — the aquilla-identity
// token response no longer carries gitlab_* fields (frontier-server retired).
export interface PersistedSession {
  jwt: string
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
    const r = await ctx.post(`${FRONTIER_BASE}/api/v1/auth/token`, {
      data: { username: u.username, password: u.password },
    })
    if (!r.ok()) {
      throw new Error(`login ${username} failed: HTTP ${r.status()} — ${await r.text()}`)
    }
    const auth = (await r.json()) as AuthResponse
    const session: PersistedSession = {
      jwt: auth.access_token,
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
    // Mirrors sessionKey() in src/lib/frontier/session-store.ts — keyed by
    // username alone now (the gitlabUrl::username scheme is retired).
    const sessionKey = s.username

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
    // Suppress the first-run product tour (FRO-243) — its modal welcome
    // dialog makes the workspace inert and blocks every role-based locator.
    localStorage.setItem("codex:productTourDone", "1")
    // Set the auth-hint cookie (aq_hint=1) that App.tsx checks via
    // hasAuthHintCookie() — without it the IDB envelope write bypasses
    // writeEnvelope() which is where setAuthHint() is normally called.
    document.cookie = "aq_hint=1; Path=/; Max-Age=31536000; SameSite=Lax"
  }, session)

  // FRO-244: the "Project setup" checklist auto-opens as a modal sheet on the
  // first workspace visit to any incomplete project, making the page inert.
  // Its localStorage key is per-project (codex.setupAutoShown.<id>) so it
  // can't be pre-seeded for projects the test creates later. Patch getItem at
  // the context level (applies to every subsequent document) so every project
  // reads as already-shown. This does NOT hide the checklist feature — the
  // setup chip still renders and setup-checklist-skip.smoke.spec.ts opens the
  // drawer explicitly through it; only the first-visit auto-open is silenced.
  await page.context().addInitScript(() => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = function (key: string) {
      if (typeof key === "string" && key.startsWith("codex.setupAutoShown.")) return "1"
      return orig.call(this, key)
    }
  })

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
