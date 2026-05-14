// Per AD-11: every discrete app reads worker URLs from VITE_AUTH_BASE etc.
// (build-time env). The api-client doesn't infer URLs from the browser
// origin because preview deploys cross-route between domains (e.g.,
// pr-N.aquilla.app/projects/ calling pr-N.aquilla.app/api/identity/).
//
// Callers can also pass `apiUrl` explicitly per call; defaults below are
// used when omitted. The legacy default points at the codex-auth-worker
// hostname (pre-Phase-3e), which 3e relocates into apps/frontier-server/.

const AUTH_DEFAULT = "https://codex-auth-worker.blue-darkness-7674.workers.dev"

// Loosely-typed accessor; the package compiles in both Vite (browser bundle)
// and Node (vitest) contexts so we can't rely on Vite's ImportMeta augmentation.
type ViteImportMeta = { env?: { VITE_AUTH_BASE?: string } } | undefined
type NodeProcess = { env?: { VITE_AUTH_BASE?: string } } | undefined

function readEnv(): string | undefined {
  try {
    const meta = (import.meta as unknown as ViteImportMeta)?.env
    if (meta?.VITE_AUTH_BASE) return meta.VITE_AUTH_BASE
  } catch {
    /* not running under a bundler that exposes import.meta */
  }
  // typeof guard keeps this safe in pure-browser bundles where `process` is
  // undefined.
  const proc = (typeof process !== "undefined" ? process : undefined) as NodeProcess
  if (proc?.env?.VITE_AUTH_BASE) return proc.env.VITE_AUTH_BASE
  return undefined
}

export const AUTH_API_URL: string = (readEnv()?.replace(/\/+$/, "")) || AUTH_DEFAULT
