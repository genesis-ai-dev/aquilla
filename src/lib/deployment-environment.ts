/**
 * deployment-environment.ts — which backend, and therefore which database, the
 * running SPA is talking to (AQU-1022).
 *
 * The browser never sees Postgres directly: every read and write goes through
 * the identity Worker (`AUTH_API_URL`) and the sync Worker (`SYNC_WORKER_HOST`),
 * each of which is bound to exactly one Neon branch (see
 * `docs/DEPLOYMENT-ENVIRONMENTS.md`). So the API hosts baked in at build time
 * *are* the datastore identity, and classifying them tells us whether what is
 * on screen is production data.
 *
 * Only `api.aquilla.app` is production. Anything else — the `dev` environment,
 * a Workers Builds preview, a local `pnpm dev` stack, or a host we don't
 * recognize — is treated as non-production so the UI fails loud rather than
 * silently passing dev data off as prod.
 */

/*
 * The build-time bases are re-read from `import.meta.env` here rather than
 * imported from `sync-token.ts` / `sync-worker-host.ts`. Those modules are
 * `vi.mock`ed by component tests, and this one is pulled in by app chrome that
 * renders everywhere — importing them would make an unrelated partial mock
 * crash at module load. The fallbacks below mirror theirs exactly, and
 * `deployment-environment.test.ts` fails if the two ever drift apart.
 */
const AUTH_BASE =
  (import.meta.env.VITE_AUTH_BASE as string | undefined) ||
  (import.meta.env.VITE_FRONTIER_BASE as string | undefined) ||
  "https://api.aquilla.app/identity"

const SYNC_BASE =
  (import.meta.env.VITE_SYNC_WORKER_HOST as string | undefined) ??
  (import.meta.env.PROD ? "api.aquilla.app/sync" : "127.0.0.1:8787")

export type DeploymentEnvironment =
  | "production"
  | "development"
  | "preview"
  | "local"
  | "unknown"

/** The one production API host from the matrix in docs/DEPLOYMENT-ENVIRONMENTS.md. */
const PRODUCTION_API_HOST = "api.aquilla.app"

/*
 * Non-production live environments are the environment-scoped hosts under the
 * same apex — `api.<env>.aquilla.app` (today only `dev`). They are matched by
 * shape, deliberately NOT listed by name: this module is compiled into every
 * bundle, and `scripts/verify-live-environment.mjs` refuses to promote a
 * production bundle that contains a non-production host literal. Spelling the
 * dev host out here is exactly what blocked the 2026-09-11 production deploy
 * (AQU-1258). Keep it a pattern.
 */
const ENVIRONMENT_API_HOST_PATTERN = /^api\.[a-z0-9-]+\.aquilla\.app$/

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])

/**
 * Reduce an API base to a bare hostname. Accepts every shape the build-time
 * vars come in as: a full URL (`https://api.aquilla.app/identity`), a
 * host-with-path (`api.aquilla.app/sync`), or a host:port
 * (`127.0.0.1:8787`).
 */
export function apiHostname(value: string): string {
  const withoutScheme = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? ""
  const afterCredentials = authority.slice(authority.lastIndexOf("@") + 1)
  // Keep IPv6 literals intact (bracketed or bare); strip the port from the rest.
  const host = afterCredentials.startsWith("[")
    ? (afterCredentials.match(/^\[[^\]]*\]/)?.[0] ?? afterCredentials)
    : afterCredentials.split(":").length > 2
      ? afterCredentials
      : afterCredentials.split(":", 1)[0]!
  return host.toLowerCase().replace(/\.$/, "")
}

/** Classify one API base URL/host. Unrecognized hosts are never "production". */
export function classifyApiHost(value: string): DeploymentEnvironment {
  const host = apiHostname(value)
  if (!host) return "unknown"
  if (host === PRODUCTION_API_HOST) return "production"
  if (ENVIRONMENT_API_HOST_PATTERN.test(host)) return "development"
  if (
    LOCAL_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return "local"
  }
  // Route-free Workers Builds preview versions (docs/DEPLOYMENT-ENVIRONMENTS.md).
  if (host.endsWith(".workers.dev")) return "preview"
  return "unknown"
}

/**
 * Loudest-first. When the identity and sync hosts disagree — a half-configured
 * build — the more alarming of the two wins, so a mixed environment can never
 * be presented as production.
 */
const ALARM_ORDER: readonly DeploymentEnvironment[] = [
  "unknown",
  "local",
  "preview",
  "development",
  "production",
]

export interface BackendEnvironment {
  kind: DeploymentEnvironment
  /** True only when every API host is a known production host. */
  isProduction: boolean
  /** Hostname the indicator names, so a screenshot says which backend it was. */
  host: string
}

/**
 * Resolve the environment the SPA is pointed at. Defaults to the build-time
 * hosts; the explicit arguments exist for tests.
 */
export function resolveBackendEnvironment(
  authBase: string = AUTH_BASE,
  syncBase: string = SYNC_BASE,
): BackendEnvironment {
  const candidates = [authBase, syncBase].map((base) => ({
    kind: classifyApiHost(base),
    host: apiHostname(base),
  }))
  const loudest = candidates.reduce((worst, candidate) =>
    ALARM_ORDER.indexOf(candidate.kind) < ALARM_ORDER.indexOf(worst.kind)
      ? candidate
      : worst,
  )
  return {
    kind: loudest.kind,
    isProduction: loudest.kind === "production",
    host: loudest.host,
  }
}
