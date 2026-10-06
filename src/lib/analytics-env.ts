/**
 * Which deployment an analytics event came from (AQU-1572).
 *
 * One PostHog project key is baked into every build — a developer's localhost,
 * dev.aquilla.app, PR previews and production — so without a marker the
 * dashboards cannot tell a developer's crash from a translator's. `posthog.ts`
 * registers the value below as the `app_env` super-property, and
 * `analytics-noise.ts` applies the same rule to keep localhost `$exception`s
 * out of the project altogether.
 *
 * Derived from the page's own origin rather than from a build-time env var:
 * the deploy scripts upload one `dist/` to an immutable version-preview URL,
 * verify it there, then promote that same bundle to aquilla.app, and a
 * `vite preview` of a production bundle on localhost is still a local build.
 *
 * Kept as a pure helper (like `posthog-host.ts`) because `posthog.ts` calls
 * `posthog.init` at import time.
 */
export type AppEnv = "production" | "dev" | "preview" | "local" | "desktop"

/**
 * The aquilla-web Worker's custom-domain routes — `[env.production]` and
 * `[env.development]` in wrangler.toml. `app.aquilla.app` is the planned home
 * of the app once the apex is marketing-only
 * (docs/specs/2026-07-31-marketing-app-namespace-design.md); it is listed now
 * so that move cannot quietly reclassify production traffic as "preview".
 */
const PRODUCTION_HOSTS = new Set(["aquilla.app", "app.aquilla.app"])
const DEV_HOSTS = new Set(["dev.aquilla.app"])

/** Loopback and wildcard-bind addresses a dev server or `vite preview` answers on. */
const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "[::1]", "::1"])
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/

/**
 * The Tauri 2 desktop shell serves its bundled assets from `tauri://localhost`
 * (macOS, Linux) or `http(s)://tauri.localhost` (Windows). Both look like
 * localhost, and both are an installed app, not a dev build. The shell's own
 * dev mode loads `devUrl` (http://127.0.0.1:1420 in src-tauri/tauri.conf.json)
 * instead, and that stays "local" like any other dev server.
 */
const TAURI_HOST = "tauri.localhost"

/** The two location fields the rule reads — satisfied by `Location` and `URL`. */
export interface AppEnvLocation {
  protocol: string
  hostname: string
}

/**
 * Classify a page origin:
 *
 * - `production` — aquilla.app
 * - `dev` — dev.aquilla.app
 * - `desktop` — the Tauri shell's bundled app (`tauri:` scheme or `tauri.localhost`)
 * - `local` — loopback, `0.0.0.0`, any `*.localhost` name, or no host at all
 * - `preview` — every other host: PR previews
 *   (`pr-<n>-aquilla-web-preview.<account>.workers.dev`), the immutable version
 *   previews the deploy scripts verify before promoting, the Workers'
 *   own `*.workers.dev` names, and the legacy brands' `*.pages.dev` deploys.
 */
export function resolveAppEnv(location: AppEnvLocation): AppEnv {
  const protocol = location.protocol.toLowerCase()
  const hostname = location.hostname.toLowerCase()

  if (protocol === "tauri:" || hostname === TAURI_HOST) return "desktop"
  if (
    !hostname ||
    LOOPBACK_HOSTS.has(hostname) ||
    IPV4_LOOPBACK.test(hostname) ||
    hostname.endsWith(".localhost")
  ) {
    return "local"
  }
  if (PRODUCTION_HOSTS.has(hostname)) return "production"
  if (DEV_HOSTS.has(hostname)) return "dev"
  return "preview"
}
