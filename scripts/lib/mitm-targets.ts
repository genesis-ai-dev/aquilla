// Planning logic for `scripts/tauri-dev-mitm.ts` — works out which upstream
// origins the desktop build talks to and what to rewrite the `VITE_*` bases to
// so every one of them lands on a local mitmproxy listener instead.
//
// Why this is worth a module of its own: the three bases are NOT guaranteed to
// share an origin. Against the remote dev environment they do
// (`api.dev.aquilla.app` for all three, distinguished only by path prefix), so
// one reverse-proxy listener covers everything. Against the local `pnpm dev`
// stack they do not — auth-worker and sync-worker are separate ports — so the
// plan has to fan out to one listener per distinct upstream. Getting this wrong
// silently sends part of the app's traffic straight past the proxy, which is
// exactly the failure a fault-injection harness must not have.

/** One mitmproxy reverse-proxy listener: local `port` fronting `upstream`. */
export interface ProxyTarget {
  /** Origin mitmproxy forwards to, e.g. `https://api.dev.aquilla.app`. */
  upstream: string
  /** Local port mitmproxy listens on (plain HTTP — no CA trust needed). */
  port: number
  /** Which `VITE_*` vars route through this listener. For log output. */
  vars: string[]
}

export interface ProxyPlan {
  targets: ProxyTarget[]
  /** `VITE_*` overrides to hand the `tauri dev` child process. */
  env: Record<string, string>
  /** Non-fatal problems worth printing before the app boots. */
  warnings: string[]
}

/** The bases that decide every host the app reaches, in stable port order. */
const PROXIED_VARS = ["VITE_AUTH_BASE", "VITE_CHAT_BASE", "VITE_SYNC_WORKER_HOST"] as const

/**
 * `VITE_SYNC_WORKER_HOST` is a bare `host[:port][/path]`, not a URL — see
 * `src/lib/sync/sync-worker-host.ts`, which strips any `ws://`/`wss://` prefix,
 * and `sync-worker-url.ts`, which then picks http/https from whether the host
 * looks local. So it round-trips scheme-less and we must not add one back.
 */
const SCHEMELESS_VARS: ReadonlySet<string> = new Set(["VITE_SYNC_WORKER_HOST"])

interface ParsedBase {
  origin: string
  /** Path prefix to preserve, e.g. `/identity`. `""` when there is none. */
  prefix: string
}

/**
 * Mirrors `isLocalHost` in `src/lib/sync/sync-worker-url.ts` so a scheme-less
 * local host resolves to http, the way the app itself resolves it.
 */
function isLocalHost(host: string): boolean {
  return /^(127\.|localhost|0\.0\.0\.0)/.test(host)
}

/**
 * Splits a configured base into the origin to proxy and the path prefix to
 * preserve. Accepts both full URLs (`VITE_AUTH_BASE`) and the scheme-less
 * host form (`VITE_SYNC_WORKER_HOST`).
 */
export function parseBase(raw: string): ParsedBase {
  const trimmed = raw.trim()
  if (trimmed === "") throw new Error("empty base")
  // `wss://`/`ws://` is tolerated on the sync host because the app strips it.
  const normalized = trimmed.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://")

  // Split scheme from the rest by hand rather than trimming the whole string:
  // a blanket trailing-slash strip turns a scheme-only value like `http://`
  // into `http:`, which `new URL` then happily parses as the host `http` —
  // a silently wrong origin instead of the error it should be.
  const scheme = /^https?:\/\//.exec(normalized)?.[0]
  const rest = scheme ? normalized.slice(scheme.length) : normalized
  if (rest === "" || rest.startsWith("/")) throw new Error(`no host in: ${raw}`)

  let url: URL
  try {
    url = new URL(`${scheme ?? (isLocalHost(rest) ? "http://" : "https://")}${rest}`)
  } catch {
    throw new Error(`not a usable host or URL: ${raw}`)
  }
  if (url.hostname === "") throw new Error(`no host in: ${raw}`)

  const prefix = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")
  return { origin: url.origin, prefix }
}

/**
 * Builds the reverse-proxy plan for a resolved Vite env.
 *
 * `basePort` is the first listener port; each additional distinct upstream
 * takes the next one. Ports are assigned in `PROXIED_VARS` order rather than
 * discovery order so two runs against the same config produce the same
 * mapping — otherwise the mitmproxy output you were reading last session
 * points at a different worker this session.
 */
export function planProxyTargets(
  env: Record<string, string | undefined>,
  basePort: number,
): ProxyPlan {
  const targets: ProxyTarget[] = []
  const byUpstream = new Map<string, ProxyTarget>()
  const rewritten: Record<string, string> = {}
  const warnings: string[] = []

  for (const name of PROXIED_VARS) {
    const raw = env[name]
    if (raw === undefined || raw.trim() === "") {
      // Left unset, the app falls back to a built-in default (production for
      // VITE_AUTH_BASE) that routes around the proxy entirely — so a fault
      // injected here would appear to do nothing to that surface.
      warnings.push(
        `${name} is unset — that surface uses its built-in default and will NOT go through mitmproxy.`,
      )
      continue
    }

    let parsed: ParsedBase
    try {
      parsed = parseBase(raw)
    } catch (err) {
      throw new Error(`${name}: ${(err as Error).message}`, { cause: err })
    }

    let target = byUpstream.get(parsed.origin)
    if (!target) {
      target = { upstream: parsed.origin, port: basePort + byUpstream.size, vars: [] }
      byUpstream.set(parsed.origin, target)
      targets.push(target)
    }
    target.vars.push(name)

    const local = `127.0.0.1:${target.port}${parsed.prefix}`
    rewritten[name] = SCHEMELESS_VARS.has(name) ? local : `http://${local}`
  }

  if (targets.length === 0) {
    throw new Error(
      "none of VITE_AUTH_BASE / VITE_CHAT_BASE / VITE_SYNC_WORKER_HOST is set — nothing to proxy. " +
        "Set them in .env.local, or run `pnpm dev` first so the local stack writes .env.development.local.",
    )
  }

  return { targets, env: rewritten, warnings }
}

/** `--mode` arguments for a single mitmdump process serving every target. */
export function mitmdumpModeArgs(targets: ProxyTarget[]): string[] {
  return targets.flatMap((t) => ["--mode", `reverse:${t.upstream}@${t.port}`])
}
