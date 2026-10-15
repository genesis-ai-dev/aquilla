/**
 * AQU-1405: recovery from stale lazy-route chunks after a redeploy.
 * AQU-1966: plus the one tagged event that makes the failure rate monitorable.
 *
 * A tab that was opened before a deploy still holds the old `index.html`, whose
 * lazy `import()` calls point at `assets/app-chunk-<old-hash>.js`. Once the new
 * build replaces those files the import rejects with "Failed to fetch
 * dynamically imported module" (Chrome), "error loading dynamically imported
 * module" (Firefox) or "Importing a module script failed" (Safari), and the
 * route lands on a blank panel until the user hard-refreshes. Translators on
 * slow links read that as "the app is broken", so the app reloads itself.
 *
 * Two properties matter and both are easy to get wrong:
 *
 *  - **At most one automatic reload per failing chunk per session.** The guard
 *    is keyed on the chunk URL, not on a single global flag: a later deploy in
 *    the same session names *new* hashes, so it still gets its own reload,
 *    while a chunk that is genuinely gone (bad deploy, blocked by an extension)
 *    can never reload more than once and falls through to the error UI.
 *  - **The user sees why the page went away.** A reload with no explanation
 *    looks like another crash, so a short "Updating …" notice is painted first.
 *    It is injected as plain DOM with inline styles because the caller may be a
 *    window-level `unhandledrejection` handler with no React tree to render
 *    into, and because the failing load may itself be a stylesheet.
 *  - **Every failure is reported once, recovered or not.** The PostHog
 *    `$exception` stream mixes these in with every other uncaught error, so the
 *    rate was not answerable without reading messages. `recoverFromChunkError`
 *    is the single choke point every path funnels through, so the tagged event
 *    is emitted here — including when the reload is *not* taken, which is the
 *    case the user actually suffers. A failure the browser reports as offline
 *    is excluded — see `isKnownOffline`.
 */

import { brand } from "@/branding/current-brand"
import { t } from "@/lib/i18n/standalone"
import posthog from "@/lib/posthog"

const CHUNK_LOAD_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Loading chunk",
  "ChunkLoadError",
]

export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return CHUNK_LOAD_PATTERNS.some((p) => msg.toLowerCase().includes(p.toLowerCase()))
}

/** sessionStorage slot holding the chunk keys already reloaded for this session. */
export const CHUNK_RELOAD_KEY = "aq:chunk-reload-attempted"

/** Most recent attempts retained; the list only grows on real chunk failures. */
const MAX_TRACKED_CHUNKS = 20

// Browsers put the failing URL in the message; Safari sometimes doesn't. Match
// an absolute URL first, then a root-relative asset path.
const CHUNK_URL = /(https?:\/\/[^\s'")]+|\/[^\s'")]*assets\/[^\s'")]+)/

/**
 * Identity of the failing chunk — the URL when the browser names one, otherwise
 * the message itself, so a message-only failure still de-duplicates.
 */
export function chunkLoadKey(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).trim()
  return (CHUNK_URL.exec(msg)?.[1] ?? msg).slice(0, 300)
}

/**
 * Chunk keys already auto-reloaded in this session. A value written by an older
 * build (the flag used to be the string "1") is not an array and is read as
 * "nothing attempted yet", which costs at most one extra reload on upgrade.
 */
export function readAttemptedChunks(storage: Storage): string[] {
  try {
    const raw = storage.getItem(CHUNK_RELOAD_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return [] // unavailable or corrupt storage — treat as a fresh session
  }
}

/**
 * Claim the one automatic reload for `key`. Returns false when this chunk has
 * already had it (or storage is unavailable, where a reload could not be
 * guarded and so must not happen) — the caller then shows the error UI.
 */
export function markChunkAttempted(storage: Storage, key: string): boolean {
  const attempted = readAttemptedChunks(storage)
  if (attempted.includes(key)) return false
  try {
    storage.setItem(CHUNK_RELOAD_KEY, JSON.stringify([...attempted, key].slice(-MAX_TRACKED_CHUNKS)))
  } catch {
    return false
  }
  return true
}

export const CHUNK_NOTICE_ID = "aq-chunk-reload-notice"

/** Full-screen "Updating …" notice painted over the broken page before reload. */
export function showUpdatingNotice(doc: Document, message: string): void {
  if (doc.getElementById(CHUNK_NOTICE_ID)) return
  const host = doc.createElement("div")
  host.id = CHUNK_NOTICE_ID
  host.setAttribute("role", "status")
  host.setAttribute("aria-live", "polite")
  // Inline styles only: the app's stylesheet may be the asset that failed. The
  // palette follows the resolved theme (ThemeMode puts `dark` on <html>) so the
  // notice never flashes white over a dark workspace.
  const dark = doc.documentElement.classList.contains("dark")
  host.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:2rem",
    "text-align:center",
    "font:500 1rem/1.5 system-ui,sans-serif",
    `color:${dark ? "#e5e7eb" : "#1f2937"}`,
    `background:${dark ? "#0b0f19" : "#ffffff"}`,
  ].join(";")
  host.textContent = message
  doc.body?.appendChild(host)
}

/** How the tagged failure event leaves the page — injectable so tests can read it. */
export type ChunkFailureCapture = (properties: { chunk: string; recovered: boolean }) => void

export interface ChunkRecoveryDeps {
  storage: Storage
  doc: Document
  reload: () => void
  message: string
  capture: ChunkFailureCapture
}

/**
 * AQU-1966: the one event name to count stale-chunk failures by. `recovered`
 * splits the ones the automatic reload repaired from the ones that fell through
 * to the error UI — a rising `recovered: false` share is the signal that the
 * reload guard is being spent without fixing anything (a genuinely missing
 * asset rather than a redeploy).
 */
export const CHUNK_FAILURE_EVENT = "chunk load failed"

/**
 * Chunk keys already reported in this page's lifetime. One failure commonly
 * arrives twice — Vite's `vite:preloadError` fires first and the caller's own
 * rejection follows — and counting it twice would overstate the rate. In memory
 * rather than sessionStorage on purpose: a recovery reloads the page, so a
 * repeat after the reload is a new incident and should be counted again.
 */
const reportedChunks = new Set<string>()

/** Test-only: forget which failures have been reported. */
export function __resetChunkFailureReportsForTests(): void {
  reportedChunks.clear()
}

function defaultCapture({ chunk, recovered }: { chunk: string; recovered: boolean }): void {
  // `sendBeacon` because a recovered failure reloads the page immediately after
  // this call; the batched queue would be discarded with the document.
  posthog.capture(CHUNK_FAILURE_EVENT, { chunk, recovered }, { transport: "sendBeacon" })
}

function reportChunkFailure(key: string, recovered: boolean, capture?: ChunkFailureCapture): void {
  if (reportedChunks.has(key)) return
  reportedChunks.add(key)
  try {
    ;(capture ?? defaultCapture)({ chunk: key, recovered })
  } catch {
    // Telemetry must never be the reason recovery doesn't happen.
  }
}

/**
 * AQU-1966: a chunk that fails while the browser knows it is offline is a
 * network problem, not a deploy. Reloading cannot bring the asset back, and
 * "Updating …" would be a lie about what went wrong — so the failure is left to
 * the caller's own error path, and stays out of a metric whose whole purpose is
 * to count deploys. This matters more now that recovery also covers the
 * on-demand loads behind ordinary buttons (the exporters, the denoiser), which
 * is exactly what someone on a dropped connection clicks. `navigator.onLine` is
 * only trustworthy in the negative — `true` does not prove connectivity — which
 * is the only direction relied on here.
 */
function isKnownOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}

/** Reading the property itself throws in a sandboxed iframe, not just its methods. */
function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/**
 * Reload once for a stale-chunk failure. Returns true when the reload was
 * triggered (the caller should stop — the page is going away); false when the
 * error is not a chunk failure or its one reload is already spent.
 */
export function recoverFromChunkError(err: unknown, overrides: Partial<ChunkRecoveryDeps> = {}): boolean {
  if (!isChunkLoadError(err)) return false
  if (typeof window === "undefined") return false
  if (isKnownOffline()) return false
  const key = chunkLoadKey(err)
  const storage = overrides.storage ?? sessionStorageOrNull()
  // No storage means no reload guard, and an unguarded reload could loop.
  const recovered = storage !== null && markChunkAttempted(storage, key)
  // Reported either way: a failure that did *not* recover is the one the user
  // is staring at, so it must not be the one missing from the dashboard.
  reportChunkFailure(key, recovered, overrides.capture)
  if (!recovered) return false
  const doc = overrides.doc ?? document
  const message = overrides.message ?? t("workspace.updateNotice.reloading", { app: brand.app.name })
  const reload = overrides.reload ?? (() => window.location.reload())
  showUpdatingNotice(doc, message)
  reload()
  return true
}
